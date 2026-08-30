'use strict';

/**
 * Command Routing Hub — issue #3788, simplified in #175, typed in #176, observability in #177.
 *
 * A pure-result dispatch hub that centralizes CJS routing,
 * the error taxonomy, and the no-throw contract that all command-family routers
 * currently duplicate independently.
 *
 * Design:
 *   createHub({ cjsRegistry, manifest }) -> hub
 *   hub.dispatch({ family, subcommand, args, cwd, raw })  -> Result
 *
 *   Result = { ok: true, data }
 *           | { ok: false, kind: 'UnknownCommand',  command: string }
 *           | { ok: false, kind: 'InvalidArgs',     arg: string, reason: string }
 *           | { ok: false, kind: 'HandlerRefusal',  reason: string }
 *           | { ok: false, kind: 'HandlerFailure',  message: string, cause?: Error }
 *
 * Invariants:
 *   - Hub always routes through CJS handlers. There is no SDK path (#175).
 *   - Hub never prints to stdout/stderr, never calls process.exit.
 *   - Hub never throws for an ordinary handler exception — those are caught
 *     and converted to { ok: false, kind: 'HandlerFailure', message, cause }.
 *   - EXCEPTION (ADR-3889): a thrown ExitError (the process-exit seam in
 *     src/cli-exit.cts, e.g. from io.cts's error()) is deliberately
 *     RE-THROWN, never converted — the throwing handler has already written
 *     its own stderr and is terminating with a specific exit code; wrapping
 *     it as a HandlerFailure would re-derive a generic message from
 *     ExitError's constructor default and print a second, wrong stderr line.
 *     It propagates through every caller up to the runMain() at the CLI
 *     entrypoint, the only place ExitError is meant to be caught.
 *   - The kind taxonomy is closed. Callers switch on ERROR_KINDS values.
 *   - Each error variant carries ONLY its own typed payload (#176).
 *     No cross-variant `message`/`details` escape hatches.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/command-routing-hub.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour from
 * the prior hand-written .cjs; only types are added.
 */

import { makeDispatchEvent } from './observability/event.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import observabilityLogger = require('./observability/logger.cjs');
const { createNoOpLogger } = observabilityLogger;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cliExitModule = require('./cli-exit.cjs');
const { ExitError } = cliExitModule;

// ─── Error kind constants ─────────────────────────────────────────────────────

/**
 * Closed error-kind enum. Export as a frozen object so callers can switch on
 * ERROR_KINDS.UnknownCommand etc. without relying on bare string literals.
 *
 * #175: SdkLoadFailed and SdkDispatchFailed removed — Hub is CJS-only.
 * #176: Field renamed errorKind → kind; payloads are typed per variant.
 *
 * @readonly
 */
const ERROR_KINDS = Object.freeze({
  /** The requested family/subcommand combination is not present in the manifest. */
  UnknownCommand: 'UnknownCommand',
  /** The handler rejected the supplied arguments before executing. */
  InvalidArgs: 'InvalidArgs',
  /** A CJS handler returned an explicit refusal (e.g. unsupported subcommand). */
  HandlerRefusal: 'HandlerRefusal',
  /** A handler threw an unexpected exception. */
  HandlerFailure: 'HandlerFailure',
} as const);

// ─── Result types ─────────────────────────────────────────────────────────────

interface OkResult {
  ok: true;
  data: unknown;
}

interface UnknownCommandResult {
  ok: false;
  kind: 'UnknownCommand';
  command: string;
}

interface InvalidArgsResult {
  ok: false;
  kind: 'InvalidArgs';
  arg: string;
  reason: string;
  // Optional ERROR_REASON enum value (e.g. 'USAGE'), carried separately from
  // `reason` (the human-readable explanation). Added by amendment #1642 so
  // routers migrating from direct `error(msg, ERROR_REASON.USAGE)` calls to
  // `makeInvalidArgs(...)` Results can preserve ERROR_REASON granularity
  // through the Hub Result → `error(msg, exitReason)` translation. Omitted by
  // the factory when the third arg is absent, undefined, or empty string —
  // preserves the strict-keys invariant tested at command-routing-hub.test.cjs:444.
  exitReason?: string;
}

interface HandlerRefusalResult {
  ok: false;
  kind: 'HandlerRefusal';
  reason: string;
}

interface HandlerFailureResult {
  ok: false;
  kind: 'HandlerFailure';
  message: string;
  cause?: Error;
}

type ErrResult = UnknownCommandResult | InvalidArgsResult | HandlerRefusalResult | HandlerFailureResult;
type HubResult = OkResult | ErrResult;

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Safe JSON serialisation that never throws.
 */
function _safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ─── Typed-payload factories (#176) ──────────────────────────────────────────
// Each factory returns a frozen discriminated-union variant for its kind.
// No cross-variant fields bleed between variants.
// Finding 3: all factory returns are Object.freeze'd so callers cannot mutate
// the variant invariant.

function makeUnknownCommand(command: string): Readonly<UnknownCommandResult> {
  return Object.freeze({ ok: false as const, kind: ERROR_KINDS.UnknownCommand, command });
}

function makeInvalidArgs(arg: string, reason: string, exitReason?: string): Readonly<InvalidArgsResult> {
  const obj: InvalidArgsResult = { ok: false as const, kind: ERROR_KINDS.InvalidArgs, arg, reason };
  // Conditionally add exitReason only when truthy — preserves strict-keys
  // invariant (2-arg callers must continue to produce a 4-key frozen result).
  if (exitReason) {
    obj.exitReason = exitReason;
  }
  return Object.freeze(obj);
}

function makeHandlerRefusal(reason: string): Readonly<HandlerRefusalResult> {
  return Object.freeze({ ok: false as const, kind: ERROR_KINDS.HandlerRefusal, reason });
}

/**
 * @param message  - Human-readable description of the failure.
 * @param cause    - The original thrown Error, when available.
 *   Non-Error values (strings, plain objects, etc.) are wrapped in an Error
 *   with `.thrown` set to the original value. null/undefined → no cause field.
 */
function makeHandlerFailure(message: string, cause?: unknown): HandlerFailureResult {
  const obj: {
    ok: false;
    kind: 'HandlerFailure';
    message: string;
    cause?: Error;
  } = { ok: false as const, kind: ERROR_KINDS.HandlerFailure, message };
  if (cause != null) {
    if (cause instanceof Error) {
      obj.cause = cause;
    } else {
      // Finding 4: wrap non-Error cause so downstream .cause.stack never silently returns undefined
      const wrapper = new Error('non-Error cause: ' + _safeJson(cause)) as Error & { thrown?: unknown };
      wrapper.thrown = cause;
      obj.cause = wrapper;
    }
  }
  return Object.freeze(obj);
}

// ─── Handler-return shape validator (Finding 1) ───────────────────────────────

/**
 * Required payload fields per ok:false kind.
 * `required` — fields that MUST be present (non-undefined) for the variant to be valid.
 * `allowed`  — the complete set of allowed fields (including ok, kind).
 */
const _VARIANT_SCHEMA: Record<string, { required: string[]; allowed: Set<string> }> = {
  UnknownCommand: {
    required: ['command'],
    allowed: new Set(['ok', 'kind', 'command']),
  },
 InvalidArgs: {
  required: ['arg', 'reason'],
  // Amendment #1642: exitReason? is allowed but not required.
  allowed: new Set(['ok', 'kind', 'arg', 'reason', 'exitReason']),
 },
  HandlerRefusal: {
    required: ['reason'],
    allowed: new Set(['ok', 'kind', 'reason']),
  },
  HandlerFailure: {
    required: ['message'],
    allowed: new Set(['ok', 'kind', 'message', 'cause']),
  },
};

/**
 * Validates a handler-returned { ok: false, ... } result against the typed schema.
 *
 * Returns null if valid, or a string describing the contract violation.
 */
function _validateErrResult(result: Record<string, unknown>): string | null {
  const { kind } = result;
  const schema = _VARIANT_SCHEMA[kind as string];

  // Unknown kind — not in the closed enum
  if (!schema) {
    return `handler returned unknown kind '${String(kind)}': expected one of ${Object.keys(_VARIANT_SCHEMA).join(', ')}`;
  }

  // Missing required fields
  for (const field of schema.required) {
    if (result[field] === undefined) {
      return (
        `handler returned malformed Result variant: ` +
        `kind '${String(kind)}' requires field '${field}' but it is missing. ` +
        `got: ${_safeJson(result)}`
      );
    }
  }

  // Extraneous fields outside the typed payload
  for (const key of Object.keys(result)) {
    if (!schema.allowed.has(key)) {
      return (
        `handler returned malformed Result variant: ` +
        `kind '${String(kind)}' does not allow field '${key}'. ` +
        `expected fields: ${[...schema.allowed].join(', ')}. ` +
        `got: ${_safeJson(result)}`
      );
    }
  }

  return null; // valid
}

// ─── Hub options ──────────────────────────────────────────────────────────────

type Handler = (ctx: Record<string, unknown>) => HubResult;

interface HubOptions {
  cjsRegistry?: Record<string, Record<string, Handler>>;
  manifest?: Record<string, string[]>;
  logger?: { onEvent(event: object): void };
}

interface DispatchRequest {
  family: string;
  subcommand?: string;
  args?: unknown[];
  cwd?: string;
  raw?: boolean;
  parentTraceId?: unknown;
}

/**
 * Safe stringify for logger-failure warnings — avoids circular-ref crashes.
 */
function _safeJsonForWarn(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Construct a CommandRoutingHub.
 */
function createHub({ cjsRegistry, manifest, logger }: HubOptions = {}): { dispatch: (req: DispatchRequest) => HubResult } {
  const _cjsRegistry = cjsRegistry;
  const _manifest = manifest;
  // Default to no-op so callers that don't inject a logger get pure-silent behaviour.
  // Consumers can opt into the reference impl by importing createDefaultLogger.
  const _logger = (logger && typeof logger.onEvent === 'function')
    ? logger
    : createNoOpLogger();

  /**
   * Normalise a HubResult into the DispatchEvent result shape.
   *
   * HubResult ok path:   { ok: true, data }        → { kind: 'ok', data }
   * HubResult err paths: { ok: false, kind, ...payload } → { kind, ...payload }
   */
  function _normaliseResult(hubResult: HubResult): Record<string, unknown> {
    if (hubResult.ok) {
      return { kind: 'ok', data: hubResult.data };
    }
    // err variant: already has kind + typed payload
    // Double-cast through unknown to satisfy strict index-signature check.
    return hubResult as unknown as Record<string, unknown>;
  }

  /**
   * Emit a DispatchEvent to the injected logger.
   * Logger errors NEVER propagate — they are caught and emitted as a warn line to stderr.
   */
  function _notifyLogger(command: string, args: unknown, hubResult: HubResult, parentTraceId?: unknown): void {
    try {
      const eventResult = _normaliseResult(hubResult);
      const event = makeDispatchEvent({ command, args, result: eventResult, parentTraceId });
      _logger.onEvent(event);
    } catch (logErr) {
      // Logger must never break dispatch. Emit a degraded warn line.
      try {
        process.stderr.write(
          _safeJsonForWarn({
            level: 'warn',
            source: 'DispatchLogger',
            message: 'logger.onEvent failed: ' + String((logErr as Error)?.message || logErr),
          }) + '\n'
        );
      } catch {
        // If even stderr.write fails, swallow silently — dispatch result is returned below.
      }
    }
  }

  /**
   * Dispatch a command through the hub.
   */
  function dispatch(req: DispatchRequest): HubResult {
    const { family, subcommand, args = [], parentTraceId } = req || {} as DispatchRequest;
    const command = subcommand ? `${family} ${subcommand}` : String(family);

    let result: HubResult;
    try {
      result = _dispatch(req);
    } catch (err) {
      // ADR-3889: a handler that calls io.cts's error() (or otherwise throws
      // ExitError directly) is deliberately terminating the CLI with a
      // specific exit code and a stderr write it has ALREADY performed
      // itself. Swallowing that into a HandlerFailure and re-deriving a
      // message from err.message (ExitError's generic "process exit N"
      // constructor default, since error() passes no message) would both
      // duplicate the stderr output and discard the real exit code — this
      // was invisible before ADR-3889 because io.cts's error() called
      // process.exit() directly, which this try/catch could never observe
      // (a process.exit() call terminates synchronously; it does not throw
      // and unwind through here). Re-throwing preserves that same
      // non-observability now that the termination mechanism is a throw:
      // it propagates past this hub, past every non-family-router caller,
      // up to the runMain() at the CLI entrypoint, which is the ONLY place
      // ExitError is meant to be caught.
      if (err instanceof ExitError) {
        throw err;
      }
      if (err instanceof Error) {
        result = makeHandlerFailure(err.message, err);
      } else {
        // Finding 2: preserve non-Error throwables via a wrapper Error with .thrown
        const wrapper = new Error('non-Error thrown: ' + _safeJson(err)) as Error & { thrown?: unknown };
        wrapper.thrown = err;
        result = makeHandlerFailure(String(err), wrapper);
      }
    }

    _notifyLogger(command, args, result, parentTraceId);
    return result;
  }

  function _dispatch(req: DispatchRequest): HubResult {
    const { family, subcommand, args = [], cwd, raw } = req;

    // ── manifest check ────────────────────────────────────────────────────────
    if (_manifest) {
      const knownSubcommands = _manifest[family];
      if (!knownSubcommands) {
        return makeUnknownCommand(String(family));
      }
      if (subcommand && !knownSubcommands.includes(subcommand)) {
        return makeUnknownCommand(`${family} ${subcommand}`);
      }
    }

    return _dispatchCjs({ family, subcommand, args, cwd, raw });
  }

  function _dispatchCjs({ family, subcommand, args, cwd, raw }: DispatchRequest): HubResult {
    if (!_cjsRegistry) {
      return makeUnknownCommand(String(family));
    }

    const familyHandlers = _cjsRegistry[family];
    if (!familyHandlers) {
      return makeUnknownCommand(String(family));
    }

    const handler = subcommand ? familyHandlers[subcommand] : familyHandlers[''];
    if (typeof handler !== 'function') {
      return makeUnknownCommand(subcommand ? `${family} ${subcommand}` : String(family));
    }

    // Invoke the handler. It must return a HubResult or throw.
    // If it throws, the outer try/catch in dispatch() catches it.
    const result = handler({ family, subcommand, args, cwd, raw });

    // If the handler returned a HubResult, validate ok:false variants against the typed schema.
    if (result && typeof result === 'object' && 'ok' in result) {
      if (!result.ok) {
        // Finding 1: runtime-validate ok:false variant shape; coerce malformed to HandlerFailure
        const violation = _validateErrResult(result as unknown as Record<string, unknown>);
        if (violation !== null) {
          return makeHandlerFailure(
            'handler returned malformed Result variant: ' + violation,
            // eslint-disable-next-line @typescript-eslint/no-base-to-string, @typescript-eslint/restrict-plus-operands
            new Error('expected ' + ((result as unknown as Record<string, unknown>)['kind'] ?? '<no kind>') + ', got ' + _safeJson(result))
          );
        }
      }
      return result;
    }

    // If the handler returned nothing (undefined), treat as success with no data.
    if (result === undefined || result === null) {
      return { ok: true, data: null };
    }

    // Any other return value is treated as the data payload.
    return { ok: true, data: result };
  }

  return { dispatch };
}

export = {
  createHub,
  ERROR_KINDS,
  makeUnknownCommand,
  makeInvalidArgs,
  makeHandlerRefusal,
  makeHandlerFailure,
};
