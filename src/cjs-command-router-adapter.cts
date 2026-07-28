/**
 * CJS Command Router Adapter Module
 *
 * Compatibility routing for gsd-tools.cjs command families. Uses generated
 * command metadata for availability and small family-local argument shapers for
 * CJS handler calls.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/cjs-command-router-adapter.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import commandRoutingHub = require('./command-routing-hub.cjs');
const { createHub, ERROR_KINDS } = commandRoutingHub;
// #2620 (ADR-0174 §6): the Hub defaults to a no-op logger and the live CLI
// dispatch path never injected the reference DispatchLogger, so GSD_AUDIT and
// config.audit.enabled were inert. Inject the reference logger ONLY when
// observability is opt-in enabled; when off, inject nothing so the Hub stays
// byte-for-byte silent (preserving the default dispatch output contract, incl.
// --json-errors). Enabling stderr-on-error unconditionally by default is a
// separate, blast-radius-bearing change (it adds a second stderr line to the
// --json-errors envelope) — deferred as its own follow-up.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import observabilityLogger = require('./observability/logger.cjs');
const { createDefaultLogger, isAuditEnabled } = observabilityLogger;
// Phase 2 (#1646): import ERROR_REASON so the UnknownCommand translation can
// pass `sdk_unknown_command` as the second arg to error(), preserving the
// JSON-error envelope contract that capability routers' tests assert on.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
const { ERROR_REASON } = io;

// ─── Types ────────────────────────────────────────────────────────────────────

type Handler = () => unknown;

interface RouteCjsCommandFamilyOptions {
  args: string[];
  subcommands: string[];
  handlers: Record<string, Handler>;
  defaultSubcommand?: string;
  unsupported?: Record<string, string>;
  unknownMessage: (subcommand: string, available: string[]) => string;
  // Amendment #1642 (#1644 Phase 1): widened to accept optional ERROR_REASON
  // enum value as second arg. io.cts's error() already accepts (msg, reason?);
  // the prior one-arg signature was narrower than the runtime contract.
  error: (message: string, reason?: string) => void;
  cwd?: string;
  raw?: boolean;
}

interface RouteHubCommandFamilyOptions {
  family: string;
  args: string[];
  subcommands: string[];
  handlers: Record<string, Handler>;
  defaultSubcommand?: string;
  unsupported?: Record<string, string>;
  unknownMessage: (subcommand: string, available: string[]) => string;
  error: (message: string, reason?: string) => void;
  cwd?: string;
  raw?: boolean;
}

// ─── Implementation ───────────────────────────────────────────────────────────

function routeCjsCommandFamily({
  args,
  subcommands,
  handlers,
  defaultSubcommand,
  unsupported = {},
  unknownMessage,
  error,
  cwd,
  raw,
}: RouteCjsCommandFamilyOptions): void {
  routeHubCommandFamily({
    family: '__legacy_cjs_family__',
    args,
    subcommands,
    handlers,
    defaultSubcommand,
    unsupported,
    unknownMessage,
    error,
    cwd,
    raw,
  });
}

/**
 * Hub-backed family router adapter.
 *
 * Deepens the command-topology seam by routing family handlers through
 * CommandRoutingHub's typed Result contract instead of ad-hoc per-router
 * lookup + error handling branches.
 */
function routeHubCommandFamily({
  family,
  args,
  subcommands,
  handlers,
  defaultSubcommand,
  unsupported = {},
  unknownMessage,
  error,
  cwd,
  raw,
}: RouteHubCommandFamilyOptions): void {
  const subcommand = args[1] || defaultSubcommand;

  if (subcommand && unsupported[subcommand]) {
    error(unsupported[subcommand]);
    return;
  }

  const available = subcommands.filter((s) => !unsupported[s]);
  const registryHandlers = Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [
      name,
      // Honestified via amendment #1642 (#1644 Phase 1): the runtime check
      // `'ok' in result` already passes any `{ok:*}` object through, so the
      // historical `{ok:true, data}` return type was a lie whenever the
      // handler returned an err Result. The lying cast below is preserved
      // because the Hub's `export =` syntax doesn't expose `HubResult` for
      // import; the Hub's `_validateErrResult` runtime-validates the actual
      // shape, so structural compatibility is sufficient. The wrapper's
      // 0-arg signature is assignable to the Hub's `(ctx) => HubResult`
      // Handler type via TypeScript parameter bivariance; the Hub's per-call
      // ctx is intentionally ignored (host-router handlers don't use it;
      // capability-router handlers in Phase 2 will return HubResults that
      // already carry context).
      (): { ok: true; data: unknown } => {
        const result = handler();
        if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'ok')) {
          return result as { ok: true; data: unknown };
        }
        return { ok: true as const, data: null };
      },
    ]),
  );

  const hub = createHub({
    cjsRegistry: { [family]: registryHandlers },
    manifest: { [family]: available },
    // #2620: wire the reference logger onto the live dispatch path (ADR-0174 §6),
    // but only when observability is opt-in enabled — otherwise leave it unset
    // so the Hub falls back to the no-op logger and stays byte-for-byte silent.
    logger: isAuditEnabled() ? createDefaultLogger({ cwd }) : undefined,
  });

  const result = hub.dispatch({
    family,
    subcommand,
    args: args.slice(2),
    cwd,
    raw,
  });

  if (result.ok) return;
  if (result.kind === ERROR_KINDS.UnknownCommand) {
    // Phase 2 (#1646): pass SDK_UNKNOWN_COMMAND as the second arg so the
    // JSON-error envelope (GSD_JSON_ERRORS=1) preserves the typed reason
    // for downstream consumers. Additive for host routers (their existing
    // one-arg `error` callbacks ignore the second arg); required for
    // capability routers whose tests assert on `reason === 'sdk_unknown_command'`.
    error(unknownMessage(subcommand ?? '', available), ERROR_REASON.SDK_UNKNOWN_COMMAND);
    return;
  }
  if (result.kind === ERROR_KINDS.InvalidArgs) {
    // Amendment #1642 (#1644): when the handler provided exitReason, pass it
    // as the second arg to error() so the JSON-error envelope
    // (GSD_JSON_ERRORS=1) preserves the typed ERROR_REASON value for
    // downstream consumers. When exitReason is absent, call error(msg) with
    // exactly one arg — byte-identical with prior behavior.
    const invalidArgs = result as { reason: string; exitReason?: string };
    if (invalidArgs.exitReason) {
      error(invalidArgs.reason, invalidArgs.exitReason);
    } else {
      error(invalidArgs.reason);
    }
    return;
  }
  if (result.kind === ERROR_KINDS.HandlerRefusal) {
    error((result as { reason: string }).reason);
    return;
  }
  error((result as { message: string }).message);
}

export = {
  routeCjsCommandFamily,
  routeHubCommandFamily,
};
