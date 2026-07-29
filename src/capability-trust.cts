/**
 * Capability trust gate — ADR-1244 Phase 4 (Decision D5 + the compatibility half of D6), extended
 * by ADR-2782 Phase 3 (#2796) with a FOURTH executable-surface class: the reviewer lane.
 *
 * PURE module. It computes *what* a capability would do and *whether* policy allows it; it
 * never mutates the filesystem and never performs I/O beyond reading staged files to confirm
 * declared executable artifacts exist. The actual consent decision (yes/no) is passed in by the
 * caller — GSD has no interactive-prompt layer in lib (the runtime/CLI edge owns that), so the
 * gate stays testable and side-effect-free. See docs/explanation/capability-trust-model.md.
 *
 * LEAF MODULE — imports ONLY: node:fs, node:path, and ./semver-compare.cjs.
 *
 * ADR-2782 D5 (#2796): a `reviewer` lane is piped the plan text, requirements, research findings
 * and CONTEXT.md decisions, then its output is read back into REVIEWS.md — making it an executable
 * surface exactly like a hook, command module, or MCP server, and it is disclosed and consent-bound
 * the same way. `disclosureSignature` appends the lane element to its output ONLY when at least one
 * lane is declared (D4.5) — a lane-free manifest's signature stays byte-identical to before this
 * class existed, so no already-consented capability re-prompts on upgrade. The RESOLVED host (as
 * opposed to the declared `hostConfigKey`) is disclosed to a human but deliberately EXCLUDED from
 * the signature — the loader has no config resolver and must compute the same signature as the
 * lifecycle (constraint 2, `.gsd/phase/chore-2796-reviewer-trust-disclosure/40-design.md`).
 *
 * Exports:
 *   RESERVED_NAMESPACES               — id prefixes third parties may not claim
 *   discloseExecutableSurfaces(...)   — enumerate hooks / command modules / mcpServers / reviewer lanes
 *   collectReviewerLaneSurfaces(...)  — the reviewer-lane collector, independently testable
 *   checkReservedNamespace(id)        — is this id in a reserved namespace?
 *   evaluateSourceAllowed(parsed,...) — strictKnownRegistries enforcement
 *   checkEngines(manifest, host)      — engines.gsd hard gate + compatVersions downgrade
 *   evaluateInstallTrust(args)        — compose: source + namespace + engines + disclosure
 *   executableSetChanged(old, new)    — did the executable surface set change between versions?
 *   summarizeDisclosure(disclosure)   — human-readable consent-prompt lines
 *   UNRESOLVED_HOST_MARKER            — the non-blank marker for an unresolved openai-http host
 *   EGRESS_PAYLOAD_CLASSES            — the named data classes every reviewer lane receives
 */

import fs from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const semverMod = require('./semver-compare.cjs') as {
  semverSatisfies: (version: string, range: string) => boolean;
  isSemverNewer: (a: string, b: string) => boolean;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Id prefixes reserved for first-party / vendor capabilities. A third-party capability whose
 * id begins with any of these is rejected at install so it cannot impersonate a first-party
 * one. Match is case-insensitive on the normalized id.
 */
const RESERVED_NAMESPACES = ['gsd-', 'gsd-core-', 'anthropic-'];

/**
 * ADR-2782 D5's gating requirement (#2796): every reviewer lane is piped the plan text,
 * requirements, research findings and CONTEXT.md decisions. Named explicitly here so disclosure
 * says exactly this — never the unhelpful "sends data to the tool" (design section B5).
 */
const EGRESS_PAYLOAD_CLASSES = ['plan text', 'requirements', 'research findings', 'CONTEXT.md decisions'];

/**
 * B3 (#2796 matrix): `resolvedHost` must never be a blank string — a blank reads as "no
 * destination" rather than "not resolved". This marker is disclosed for an `openai-http` lane
 * when no resolver was supplied to `collectReviewerLaneSurfaces`, or the supplied resolver could
 * not resolve the declared `hostConfigKey`. Deliberately NOT part of `disclosureSignature`'s input
 * (see the lane signature line) — only the human-facing surface carries it.
 */
const UNRESOLVED_HOST_MARKER = '(unresolved — no host resolver was supplied at disclosure time)';

/**
 * Loopback hostnames recognized LITERALLY, never by substring (an evil host must not spoof this,
 * e.g. `notlocalhost.example`). D5: localhost is not "safe by default" — it is disclosed and
 * FLAGGED, never omitted (matrix B4).
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CapabilityManifest {
  id?: unknown;
  version?: unknown;
  engines?: unknown;
  compatVersions?: unknown;
  hooks?: unknown;
  commands?: unknown;
  mcpServers?: unknown;
  /** ADR-2782 (#2796): a single reviewer-lane body — never an array (Phase 2's own validator rejects that shape). */
  reviewer?: unknown;
  [k: string]: unknown;
}

interface HookSurface {
  event: string;
  script: string;
}

interface CommandModuleSurface {
  family: string;
  module: string;
  /**
   * TRUST2-3 (#1459): the exported function the host invokes from the module — WHICH code runs. A
   * version that keeps family+module but retargets `router` to a different exported function changes
   * what executes, so it is part of the disclosed + consent-bound surface. Empty when undeclared.
   */
  router: string;
}

interface McpServerSurface {
  name: string;
  /**
   * The transport TYPE: 'stdio' (spawns command/argv), 'http', or 'sse' (connects to a URL). TRUST2-2
   * (#1459): a non-stdio server was previously invisible to the disclosure/signature — its url/headers
   * could be swapped with no re-consent. Empty when undeclared (the host default is stdio).
   */
  transport: string;
  /** The command the server spawns (the actual executable — disclosed for honest consent). stdio only. */
  command: string;
  /**
   * Arguments passed to the command. TRUST2-4 (#1459): this is a stringified view for the human
   * summary; the consent SIGNATURE encodes the RAW args array (incl non-string members) via
   * `rawArgs` so a non-string arg change still forces re-consent (the host receives the raw args).
   */
  argv: string[];
  /**
   * The RAW args array as declared (may contain non-strings). Folded — stable-encoded — into the
   * signature so a change to ANY member (incl a number/object/bool the host would still pass) forces
   * re-consent (TRUST2-4). Empty array when none declared.
   */
  rawArgs: unknown[];
  /**
   * The URL an http/sse server connects to — TRUST2-2: WHERE the server talks to. A url change is a
   * different remote endpoint and must force re-consent. Empty when undeclared (stdio servers).
   */
  url: string;
  /**
   * The HTTP headers an http/sse server is given (string→string, stable-sorted) — TRUST2-2: headers
   * carry auth/behavior and a change must force re-consent. Header VALUES are redacted in the human
   * summary but INCLUDED in the signature. Empty object when none.
   */
  headers: Record<string, string>;
  /**
   * Environment variables (string→string only) the server is spawned with — disclosed because
   * env can change WHAT a command does (e.g. NODE_OPTIONS=--require /tmp/evil.js) without touching
   * command/argv. Any add/change forces re-consent (TRUST-2, #1459). Empty object when none.
   */
  env: Record<string, string>;
  /** The working directory the server is spawned in (if declared) — also affects what runs. */
  cwd?: string;
  /**
   * Finding 5 (MEDIUM, #1459): the FULL declared server config object (prototype-pollution-safe
   * shallow-cleaned copy). The writer persists the WHOLE config ({...config}), so the signature must
   * bind the WHOLE config — not only the whitelisted fields above — or an upgrade that changes a
   * host-honored field NOT in the whitelist (a future `envFile`/`workingDir`/launch option) would be
   * written verbatim yet leave the signature constant → no re-consent prompt. This is folded into the
   * signature as STABLE (recursively key-sorted) JSON, so any add/change forces re-consent while a
   * pure key reorder does not. NOT shown in the human summary (which stays readable via the key fields).
   */
  rawConfig: Record<string, unknown>;
}

/**
 * Resolves a reviewer lane's `hostConfigKey` (a dotted key into `.planning/config.json`) to its
 * configured destination host, for HUMAN disclosure only. Optional — the loader has no config
 * access and calls `discloseExecutableSurfaces`/`signatureForManifest` without one; the lifecycle
 * MAY supply one so the consent prompt shows a real destination instead of `UNRESOLVED_HOST_MARKER`.
 * MUST NOT throw is not required of the caller — `collectReviewerLaneSurfaces` treats any thrown
 * error or non-string/empty return as "could not resolve" and falls back to the marker.
 */
type ReviewerHostResolver = (hostConfigKey: string) => string | undefined;

/**
 * ADR-2782 D5 (#2796): the reviewer-lane executable surface. A capability manifest carries AT MOST
 * ONE `reviewer` body (Phase 2's validator rejects an array), so this collector returns 0 or 1
 * entries per manifest — the array return shape matches the other three collectors for a uniform
 * `Disclosure` and lets `disclosureSignature` sort/fold it the same way.
 */
interface ReviewerLaneSurface {
  /** The lane's declared identity (also its config/flag namer). Empty when undeclared/malformed. */
  slug: string;
  /** `'spawn'` | `'openai-http'` as declared, or '' when absent/malformed — disclosure never validates. */
  transport: string;
  /** spawn: the executable name/path as declared. Empty for an openai-http lane or when undeclared. */
  binary: string;
  /** spawn: the declared args, RENDERED (string-filtered) for the human summary — mirrors MCP's argv. */
  args: string[];
  /**
   * spawn: the FULL declared args array (may contain non-strings the host still receives) — folded
   * into the signature so ANY member change forces re-consent (matrix A6, the #1459 bug class:
   * `python3` with innocuous args later becoming `['-c', '<program>']`). Empty when undeclared.
   */
  rawArgs: unknown[];
  /** openai-http: the dotted config key naming the destination host. Empty for a spawn lane. */
  hostConfigKey: string;
  /**
   * openai-http: the resolved destination host when a resolver was supplied and could resolve
   * `hostConfigKey`; `UNRESOLVED_HOST_MARKER` when a resolver was not supplied or could not resolve
   * it. NEVER '' for an openai-http lane (matrix B3) — a blank reads as "no destination". '' for a
   * spawn lane (no destination concept — mirrors McpServerSurface's empty-when-inapplicable
   * convention). Deliberately EXCLUDED from `disclosureSignature`'s input (design constraint 2): the
   * loader has no resolver and must compute the SAME signature as the lifecycle.
   */
  resolvedHost: string;
  /**
   * True when `resolvedHost` is a loopback/local destination. D5: localhost is disclosed like any
   * other destination, never treated as "safe by default" (matrix B4). Always false for a spawn
   * lane and for an unresolved openai-http host.
   */
  isLocalDestination: boolean;
  /** How the review prompt reaches the lane (`'stdin'|'argv'|'argv-file-ref'|'none'`, or ''). */
  promptChannel: string;
  /** The first-party handler module name that post-processes this lane's output, or '' when undeclared. */
  handler: string;
  /**
   * The data classes that egress to this lane on every run (`EGRESS_PAYLOAD_CLASSES`) — named
   * honestly (Kerckhoffs's Principle) rather than disclosed as an unhelpful "sends data to the tool".
   */
  egressPayloadClasses: string[];
}

interface Disclosure {
  /** Hook scripts the capability registers (each runs as a runtime hook command). */
  hooks: HookSurface[];
  /** Command modules the capability ships (each is require()'d into the GSD CLI process). */
  commandModules: CommandModuleSurface[];
  /** MCP servers the capability declares (each spawned by the host runtime) — name AND command. */
  mcpServers: McpServerSurface[];
  /**
   * ADR-2782 (#2796): the reviewer lane this capability declares — 0 or 1 entries (a manifest
   * carries at most one `reviewer` body). A fourth executable-surface class alongside the three
   * above; a standing egress channel to an external reviewer.
   */
  reviewerLanes: ReviewerLaneSurface[];
  /** True when the capability ships ANY executable surface (=> consent required). */
  hasExecutable: boolean;
  /**
   * Declared module/script files that were NOT found under the staged dir (defensive — a
   * manifest referencing a missing artifact is suspicious; surfaced, not silently dropped).
   * Empty when no stagedDir was supplied.
   */
  missingArtifacts: string[];
}

type StrictKnownRegistries = string[] | null | undefined;

interface ParsedSpec {
  kind: 'registry' | 'git' | 'npm' | 'tarball' | 'local';
  raw: string;
  target: string;
  ref?: string;
}

interface SourceVerdict {
  allowed: boolean;
  reason: string | null;
}

interface EnginesVerdict {
  /** Does the capability's *current* version run on this host? */
  compatible: boolean;
  /** The declared engines.gsd range, or null if unconstrained. */
  range: string | null;
  satisfiedBy: 'engines' | 'compatVersions' | 'unconstrained' | null;
  /** When the current version is incompatible but compatVersions names one that works. */
  downgradeTo?: string;
}

interface InstallTrustArgs {
  parsed: ParsedSpec;
  manifest: CapabilityManifest;
  /** Optional staged dir — when given, declared artifacts are existence-checked. */
  stagedDir?: string;
  strictKnownRegistries?: StrictKnownRegistries;
  hostVersion: string;
  /**
   * Optional (#2796): resolves a reviewer lane's `hostConfigKey` to its configured destination, for
   * HUMAN disclosure at install time only — never folds into the consent signature (design
   * constraint 2; see `ReviewerHostResolver`).
   */
  resolveHost?: ReviewerHostResolver;
}

interface InstallTrustVerdict {
  /** True when no policy gate blocks the install. */
  allowed: boolean;
  /** True when the install is allowed BUT ships executable surfaces => needs consent. */
  requiresConsent: boolean;
  disclosure: Disclosure;
  engines: EnginesVerdict;
  /** Non-empty when allowed === false; each string is a human-readable block reason. */
  blockReasons: string[];
}

// ---------------------------------------------------------------------------
// Disclosure
// ---------------------------------------------------------------------------

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Run `fn`, returning `fallback` instead of throwing. Makes each per-class collector total: a
 * hostile manifest (a Proxy with a throwing trap, a throwing getter, or a non-object/null root)
 * degrades ONE surface class to empty rather than crashing disclosure for the other three classes
 * behind it in the same manifest (ADR-2782 #2796 — disclosure runs before validation and must never
 * throw; matrix C5/E2).
 */
function safeCollect<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * Recognize a loopback/local destination from a RESOLVED openai-http host value (matrix B4). Matches
 * literally, never by substring — an evil host must not spoof `localhost` via e.g.
 * `notlocalhost.example`. Falls back to a scheme-less leading-segment match so a bare config value
 * like `localhost:1234` or `192.168.1.5:8080` (no `http://` prefix) is still recognized.
 *
 * The fallback triggers on EITHER `new URL()` throwing (a value that is not parseable as an absolute
 * URL at all, e.g. `192.168.1.5:8080` — WHATWG scheme names cannot start with a digit) OR it
 * succeeding with an EMPTY hostname: `new URL('localhost:1234')` does NOT throw — it mis-parses the
 * scheme-less `host:port` shape as an opaque URL whose "scheme" IS the hostname text
 * (`protocol: "localhost:"`, `hostname: ""`), which would otherwise silently fail to recognize a
 * bare local config value as local.
 */
function isLocalHostValue(hostValue: string): boolean {
  let hostname = '';
  try {
    hostname = new URL(hostValue).hostname;
  } catch {
    hostname = '';
  }
  if (!hostname) {
    hostname = extractBareHost(hostValue);
  }
  // WHATWG returns an IPv6 hostname bracketed; a bare config value may not be.
  const lower = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (LOOPBACK_HOSTNAMES.has(lower)) return true;
  if (isLoopbackIpv6(lower)) return true;
  return isLoopbackIpv4(lower);
}

/**
 * Pull the host out of a value `new URL()` could not parse — a scheme-less
 * `host:port`, or one carrying a path/query/fragment.
 *
 * IPv6 needs explicit handling: splitting on `:` mangles `[::1]:8080` to `[`,
 * which then matches nothing and silently reports a loopback destination as
 * remote. A bracketed literal is taken through its closing bracket; an unbracketed
 * value with two or more colons is treated as a bare IPv6 address rather than
 * `host:port`, since a host:port has exactly one.
 */
function extractBareHost(hostValue: string): string {
  let s = String(hostValue).trim();
  const schemeEnd = s.indexOf('://');
  if (schemeEnd >= 0) s = s.slice(schemeEnd + 3);
  s = s.split(/[/?#]/)[0] || '';
  if (s.startsWith('[')) {
    const close = s.indexOf(']');
    return close > 0 ? s.slice(1, close) : s;
  }
  const colons = (s.match(/:/g) || []).length;
  if (colons >= 2) return s;
  return colons === 1 ? s.slice(0, s.indexOf(':')) : s;
}

/**
 * Render one declared argv member for the human consent prompt.
 *
 * A string prints as itself. Anything else prints in a form that makes its
 * presence and shape visible rather than vanishing: an argv member the host
 * still receives, but which the user was never shown, is a surface consented to
 * unseen. Never throws — a circular or BigInt member must not break the prompt.
 */
function renderArgForHuman(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (typeof arg === 'bigint') return `<${String(arg)}n>`;
  try {
    const json = JSON.stringify(arg);
    return json === undefined ? `<${typeof arg}>` : `<${json}>`;
  } catch {
    return `<${typeof arg}>`;
  }
}

/** `::1`, its expanded forms, and IPv4-mapped loopback (`::ffff:127.0.0.1`). */
function isLoopbackIpv6(host: string): boolean {
  if (!host.includes(':')) return false;
  if (host === '::1') return true;
  const mapped = /^::ffff:(.+)$/i.exec(host);
  if (mapped) return isLoopbackIpv4(mapped[1]);
  const groups = host.split(':').filter((g) => g !== '');
  if (groups.length === 0) return false;
  return groups.every((g, i) => (i === groups.length - 1 ? /^0*1$/.test(g) : /^0*$/.test(g)));
}

/**
 * 127.0.0.0/8 under inet_aton semantics, which is what a browser, curl and the
 * OS resolver all accept. `127.1`, `2130706433`, `0x7f000001` and `0177.0.0.1`
 * are every bit as loopback as `127.0.0.1`; a disclosure that flags only the
 * dotted-quad form understates a local destination for the other four.
 */
function isLoopbackIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return false;
  const nums: number[] = [];
  for (const part of parts) {
    let n: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) n = parseInt(part, 16);
    else if (/^0[0-7]+$/.test(part)) n = parseInt(part, 8);
    else if (/^\d+$/.test(part)) n = parseInt(part, 10);
    else return false;
    if (!Number.isFinite(n) || n < 0) return false;
    nums.push(n);
  }
  // inet_aton: the final part absorbs every remaining octet.
  let addr: number;
  if (nums.length === 1) addr = nums[0];
  else if (nums.length === 2) addr = ((nums[0] & 0xff) * 0x1000000) + (nums[1] & 0xffffff);
  else if (nums.length === 3) addr = ((nums[0] & 0xff) * 0x1000000) + ((nums[1] & 0xff) * 0x10000) + (nums[2] & 0xffff);
  else addr = ((nums[0] & 0xff) * 0x1000000) + ((nums[1] & 0xff) * 0x10000) + ((nums[2] & 0xff) * 0x100) + (nums[3] & 0xff);
  if (!Number.isFinite(addr) || addr < 0 || addr > 0xffffffff) return false;
  return Math.floor(addr / 0x1000000) === 127;
}

/**
 * Collect the `hooks` executable-surface class: [{ event, script }] — scripts run as runtime hook
 * commands. Extracted from the former monolithic `discloseExecutableSurfaces` (ADR-2782 #2796,
 * cyclomatic 51 / cognitive 99 / 110 lines / `risk_level: critical`) — BEHAVIOR UNCHANGED, only
 * isolated so it is independently testable and the orchestrator shrinks instead of growing a fourth
 * class inline. `missingArtifacts` is a shared accumulator the orchestrator passes to every collector
 * that can populate it.
 */
function collectHookSurfaces(
  manifest: CapabilityManifest,
  stagedDir: string | undefined,
  missingArtifacts: string[],
): HookSurface[] {
  const hooks: HookSurface[] = [];
  if (Array.isArray(manifest.hooks)) {
    for (const h of manifest.hooks) {
      if (typeof h !== 'object' || h === null) continue;
      const rec = h as Record<string, unknown>;
      const script = asString(rec['script']);
      const event = asString(rec['event']);
      if (script) {
        hooks.push({ event, script });
        if (stagedDir && !artifactExists(stagedDir, script)) {
          missingArtifacts.push(script);
        }
      }
    }
  }
  return hooks;
}

/**
 * Collect the `commands` executable-surface class: [{ family, module, router? }] — modules
 * require()'d into the GSD CLI process. Extracted, BEHAVIOR UNCHANGED — see `collectHookSurfaces`.
 */
function collectCommandSurfaces(
  manifest: CapabilityManifest,
  stagedDir: string | undefined,
  missingArtifacts: string[],
): CommandModuleSurface[] {
  const commandModules: CommandModuleSurface[] = [];
  if (Array.isArray(manifest.commands)) {
    for (const c of manifest.commands) {
      if (typeof c !== 'object' || c === null) continue;
      const rec = c as Record<string, unknown>;
      const moduleName = asString(rec['module']);
      const family = asString(rec['family']);
      // TRUST2-3 (#1459): capture the router (which exported fn runs) so retargeting it forces re-consent.
      const router = asString(rec['router']);
      if (moduleName) {
        commandModules.push({ family, module: moduleName, router });
        if (stagedDir && !artifactExists(stagedDir, moduleName)) {
          missingArtifacts.push(moduleName);
        }
      }
    }
  }
  return commandModules;
}

/**
 * Collect the `mcpServers` executable-surface class: object map { name: { command, args } } OR
 * array [{ name, command, args }] (or array [{ name, config: { command, args } }]). Captures the
 * COMMAND, not just the name — the command is the executable that actually runs, and consent must
 * disclose it (Codex R1 H1). Extracted, BEHAVIOR UNCHANGED — see `collectHookSurfaces`. Unlike
 * hooks/commands, an MCP server's command is never existence-checked against `stagedDir` (exactly
 * like a reviewer lane's `binary` — see `collectReviewerLaneSurfaces` — it may be any PATH
 * executable, not necessarily a bundle artifact), so this collector takes no `missingArtifacts`
 * accumulator.
 */
function collectMcpSurfaces(manifest: CapabilityManifest): McpServerSurface[] {
  const mcpServers: McpServerSurface[] = [];
  if (manifest.mcpServers && typeof manifest.mcpServers === 'object') {
    const pushServer = (name: string, config: unknown): void => {
      if (!name) return;
      const cfg = (typeof config === 'object' && config !== null) ? (config as Record<string, unknown>) : {};
      const command = asString(cfg['command']);
      // TRUST2-4 (#1459): the RAW args array (incl non-string members) is what the host receives, so it
      // is folded — stable-encoded — into the signature. `argv` is the string-filtered view for the
      // human summary; `rawArgs` is the full declared array bound into the signature.
      const rawArgs = Array.isArray(cfg['args']) ? (cfg['args'] as unknown[]) : [];
      const argv = rawArgs.filter((a): a is string => typeof a === 'string');
      // TRUST2-2 (#1459): a non-stdio MCP server ({ type|transport, url, headers }) was previously
      // invisible to the disclosure/signature. Capture the transport TYPE, the URL, and the HEADERS
      // (string→string, prototype-pollution-safe) so a swapped endpoint or header forces re-consent.
      const transport = asString(cfg['type']) || asString(cfg['transport']);
      const url = asString(cfg['url']);
      const headers: Record<string, string> = {};
      const rawHeaders = cfg['headers'];
      if (rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
        for (const [k, v] of Object.entries(rawHeaders as Record<string, unknown>)) {
          if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
          if (typeof v === 'string') headers[k] = v;
        }
      }
      // TRUST-2 (#1459): env can change WHAT a command does without touching command/argv, so it is
      // part of the disclosed (and consent-bound) surface. Filter to string→string entries only —
      // a non-string env value cannot be exported as a real environment variable, and including it
      // would make the signature depend on un-runnable junk. Prototype-pollution-safe: copy only
      // own enumerable string keys, never __proto__/constructor/prototype.
      const env: Record<string, string> = {};
      const rawEnv = cfg['env'];
      if (rawEnv && typeof rawEnv === 'object' && !Array.isArray(rawEnv)) {
        for (const [k, v] of Object.entries(rawEnv as Record<string, unknown>)) {
          if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
          if (typeof v === 'string') env[k] = v;
        }
      }
      const cwd = asString(cfg['cwd']);
      // Finding 5 (MEDIUM, #1459): capture the FULL config (every declared field the writer persists),
      // not just the whitelisted ones. Prototype-pollution-safe: copy only own enumerable keys and
      // never the dangerous keys. The CAP_MARKER the writer stamps on persist (`_gsdCapability`) is the
      // capability id (constant per cap), so it does not perturb the signature; we copy config as
      // DECLARED here (pre-stamp) and the writer adds the marker at write time.
      const rawConfig: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(cfg)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        rawConfig[k] = v;
      }
      const surface: McpServerSurface = { name, transport, command, argv, rawArgs, url, headers, env, rawConfig };
      if (cwd) surface.cwd = cwd;
      mcpServers.push(surface);
    };
    if (Array.isArray(manifest.mcpServers)) {
      for (const s of manifest.mcpServers) {
        if (typeof s === 'object' && s !== null) {
          const rec = s as Record<string, unknown>;
          pushServer(asString(rec['name']), rec['config'] ?? rec);
        }
      }
    } else {
      for (const [name, config] of Object.entries(manifest.mcpServers as Record<string, unknown>)) {
        pushServer(name, config);
      }
    }
  }
  return mcpServers;
}

/**
 * Collect the reviewer-lane executable-surface class (ADR-2782 D5, #2796): 0 or 1 entries, since a
 * capability manifest carries AT MOST ONE `reviewer` body (Phase 2's validator rejects an array
 * shape outright — matrix C2b). The array return shape matches the other three collectors so
 * `Disclosure`/`disclosureSignature` treat it uniformly (sort-then-fold), even though today it can
 * never hold more than one entry.
 *
 * TOTAL and absent-safe (matrix C1–C5): no `reviewer` key, `reviewer: null`, a non-object body
 * (array/boolean/number), a malformed `invoke`, non-array `flags`, or the whole manifest being a
 * throwing Proxy/getter all degrade to "no lane" rather than throwing — disclosure runs BEFORE
 * Phase 2's validation, on a manifest validation would reject outright.
 *
 * `resolveHost` is optional — supplied by the lifecycle (never the loader, which has no config
 * access) to disclose the REAL destination of an `openai-http` lane to a human at install/upgrade
 * time. Its return value is NEVER folded into `disclosureSignature` (design constraint 2: the
 * signature must stay a pure function of the manifest, or the loader and lifecycle would compute
 * different signatures for the same manifest and produce a permanent false re-consent loop).
 */
function collectReviewerLaneSurfaces(
  manifest: CapabilityManifest,
  resolveHost?: ReviewerHostResolver,
): ReviewerLaneSurface[] {
  return safeCollect(() => {
    const r = manifest.reviewer;
    // C1 (no reviewer key) / C2a (null) / C2b (non-object: array, boolean, number) all disclose no
    // lane — never an error at this layer. Validation of a malformed body is Phase 2's job.
    if (typeof r !== 'object' || r === null || Array.isArray(r)) return [];
    const rec = r as Record<string, unknown>;

    const slug = asString(rec['slug']);
    const transport = asString(rec['transport']);
    const handler = asString(rec['handler']);

    // C3: `invoke` absent/malformed still discloses a lane, with empty binary/args/rawArgs rather
    // than crashing — validating `invoke`'s shape is Phase 2's job, not disclosure's.
    const invokeRaw = rec['invoke'];
    const invoke = (typeof invokeRaw === 'object' && invokeRaw !== null && !Array.isArray(invokeRaw))
      ? (invokeRaw as Record<string, unknown>)
      : {};

    const binary = asString(invoke['binary']);
    // B1b: the RAW declared args (may contain non-strings the host still receives) is what the
    // signature binds; `args` is the string-filtered RENDERED view for a human summary — the exact
    // argv/rawArgs split MCP servers already use for the same reason (TRUST2-4, #1459).
    const rawArgsDeclared = Array.isArray(invoke['args']) ? (invoke['args'] as unknown[]) : [];
    const args = rawArgsDeclared.filter((a): a is string => typeof a === 'string');
    const hostConfigKey = asString(invoke['hostConfigKey']);
    const promptChannel = asString(invoke['promptChannel']);

    // An EMPTY (or wholly unrecognised) reviewer body declares no lane and must
    // not be treated as one. Without this, `reviewer: {}` alone flips
    // hasExecutable true and perturbs the disclosure signature — producing a
    // re-consent prompt whose only content is "(no binary declared)". That is a
    // prompt carrying no security information, which is exactly the
    // click-through-training harm this design refuses for reviewsSection and
    // timeoutFloorMs; refusing it there and permitting it here would be
    // inconsistent.
    //
    // The test is deliberately BROAD — any one recognised field with a value is
    // enough. Requiring specifically a binary, or specifically a slug, would let
    // a lane declaring only the other slip through unconsented, which is the far
    // worse failure.
    const declaresSomething = Boolean(
      slug || transport || handler || binary || hostConfigKey || promptChannel
      || rawArgsDeclared.length > 0,
    );
    if (!declaresSomething) return [];

    // B2/B3/B4: resolvedHost/isLocalDestination are only meaningful for an openai-http lane — a
    // spawn lane has no destination concept, so both stay at their inapplicable defaults ('' /
    // false), mirroring McpServerSurface's existing empty-when-inapplicable convention (e.g.
    // `url: ''` for a stdio server). For openai-http, resolvedHost never ends up '' — it is either a
    // real resolved value or the explicit UNRESOLVED_HOST_MARKER (never a blank read as "no
    // destination").
    // The shape test is deliberately WIDER than an exact transport match, and the
    // human summary uses the same one. Disclosure runs BEFORE validation, so a
    // mis-cased or unrecognised `transport` reaches here; keying only on the exact
    // string would leave a lane that plainly declares a hostConfigKey with a BLANK
    // destination, which reads as "no destination" — the precise thing B3 forbids.
    const hasHttpShape = transport === 'openai-http' || (!binary && Boolean(hostConfigKey));

    let resolvedHost = '';
    let isLocalDestination = false;
    if (hasHttpShape) {
      resolvedHost = UNRESOLVED_HOST_MARKER;
      if (typeof resolveHost === 'function') {
        let resolved: string | undefined;
        try {
          resolved = resolveHost(hostConfigKey);
        } catch {
          resolved = undefined;
        }
        if (typeof resolved === 'string' && resolved) resolvedHost = resolved;
      }
      if (resolvedHost !== UNRESOLVED_HOST_MARKER) {
        isLocalDestination = isLocalHostValue(resolvedHost);
      }
    }

    const surface: ReviewerLaneSurface = {
      slug,
      transport,
      binary,
      args,
      rawArgs: rawArgsDeclared,
      hostConfigKey,
      resolvedHost,
      isLocalDestination,
      promptChannel,
      handler,
      // B5: every lane receives the same named egress payload classes — a fresh copy per surface so
      // no caller can mutate the shared constant through a returned surface.
      egressPayloadClasses: [...EGRESS_PAYLOAD_CLASSES],
    };
    return [surface];
  }, []);
}

/**
 * Enumerate every executable surface a capability manifest declares.
 *
 * Recognizes the FOUR executable surface kinds a capability can ship:
 *   - `hooks`:    [{ event, script }]              — scripts run as runtime hook commands
 *   - `commands`: [{ family, module, router? }]    — modules require()'d into the CLI process
 *   - `mcpServers`: { <name>: {...} } | [{ name }] — servers spawned by the host runtime
 *   - `reviewer`: { slug, transport, invoke, ... }  — an external reviewer lane (ADR-2782 D5, #2796)
 *
 * `mcpServers` is not a first-party capability.json field today, but a third-party manifest may
 * declare it, so the trust gate discloses it whenever present (honest disclosure over the
 * narrower first-party schema). Pure: when `stagedDir` is provided, declared hook/command-module
 * files are existence-checked and any missing ones reported, but nothing is mutated. A reviewer
 * lane's `binary` is NEVER existence-checked against `stagedDir` (matrix C6) — like an MCP server's
 * command, it is a PATH lookup on the user's machine, never a bundle artifact; existence-checking it
 * would block every lane install.
 *
 * TOTAL: never throws, for any manifest shape — including a non-object manifest, a Proxy with
 * throwing traps, or a property with a throwing getter (matrix C5, E2). Disclosure runs BEFORE
 * Phase 2's validation, on a manifest validation would reject outright, so it must tolerate what
 * validation does not. Each surface class is collected independently (`safeCollect`) so a hostile
 * value in ONE class degrades only that class to empty rather than losing the other three.
 *
 * `resolveHost` (optional, #2796) is forwarded to `collectReviewerLaneSurfaces` so a caller with
 * config access (the lifecycle, never the loader — see `signatureForManifest`) can disclose the REAL
 * destination of an `openai-http` lane. It never affects the returned signature.
 */
function discloseExecutableSurfaces(
  manifest: CapabilityManifest,
  stagedDir?: string,
  resolveHost?: ReviewerHostResolver,
): Disclosure {
  const missingArtifacts: string[] = [];
  const hooks = safeCollect(() => collectHookSurfaces(manifest, stagedDir, missingArtifacts), [] as HookSurface[]);
  const commandModules = safeCollect(
    () => collectCommandSurfaces(manifest, stagedDir, missingArtifacts),
    [] as CommandModuleSurface[],
  );
  const mcpServers = safeCollect(() => collectMcpSurfaces(manifest), [] as McpServerSurface[]);
  const reviewerLanes = safeCollect(
    () => collectReviewerLaneSurfaces(manifest, resolveHost),
    [] as ReviewerLaneSurface[],
  );

  const hasExecutable =
    hooks.length > 0 || commandModules.length > 0 || mcpServers.length > 0 || reviewerLanes.length > 0;
  return { hooks, commandModules, mcpServers, reviewerLanes, hasExecutable, missingArtifacts };
}

/**
 * Existence-check a manifest-declared artifact path under stagedDir, refusing to follow it
 * outside the staged root (defense against `../` traversal in a hostile manifest).
 */
function artifactExists(stagedDir: string, relPath: string): boolean {
  if (!relPath || path.isAbsolute(relPath) || relPath.split(/[/\\]/).includes('..')) {
    // A traversal/absolute artifact path is treated as "not present" (and is independently
    // rejected by the validator / lifecycle); never resolve it.
    return false;
  }
  try {
    return fs.existsSync(path.join(stagedDir, relPath));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Namespace reservation
// ---------------------------------------------------------------------------

/**
 * Is `id` in a reserved namespace? Reserved prefixes are first-party/vendor-only so a
 * third-party capability cannot impersonate a first-party one.
 */
function checkReservedNamespace(id: unknown): { reserved: boolean; namespace: string | null } {
  if (typeof id !== 'string' || !id) return { reserved: false, namespace: null };
  const lower = id.toLowerCase();
  for (const ns of RESERVED_NAMESPACES) {
    if (lower.startsWith(ns)) return { reserved: true, namespace: ns };
  }
  return { reserved: false, namespace: null };
}

// ---------------------------------------------------------------------------
// strictKnownRegistries enforcement
// ---------------------------------------------------------------------------

/**
 * Extract the host of a URL-bearing spec for host-based allowlist matching. Returns '' when no
 * host can be parsed (caller treats '' as non-matching).
 */
function specHost(parsed: ParsedSpec): string {
  // git specs may be scp-style (git@host:path) or URL-style; tarball/registry are URLs.
  const raw = parsed.target || parsed.raw || '';
  const scp = /^[^@/]+@([^:]+):/.exec(raw);
  if (scp) return scp[1].toLowerCase();
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * True if `host` equals an allowlist entry or is a subdomain of it. Host-based, NOT substring:
 * `github.com` matches `github.com` and `api.github.com`, never `evilgithub.com`.
 */
function hostMatchesAllowlist(host: string, list: string[]): boolean {
  if (!host) return false;
  for (const entryRaw of list) {
    const entry = typeof entryRaw === 'string' ? entryRaw.trim().toLowerCase() : '';
    if (!entry) continue;
    if (host === entry || host.endsWith('.' + entry)) return true;
  }
  return false;
}

/**
 * True for a Windows/UNC network path. Matches any two leading slash-or-backslash characters
 * (`\\`, `//`, and the mixed `\/` / `/\` forms Windows also treats as UNC-absolute).
 */
function isUncPath(p: string): boolean {
  return /^[\\/]{2}/.test(p);
}

/** Extract the server host of a UNC path (`\\server\share` -> `server`). */
function uncHost(p: string): string {
  const m = /^[\\/]{2}([^\\/]+)/.exec(p);
  return m ? m[1].toLowerCase() : '';
}

/**
 * Apply the `capabilities.strict_known_registries` policy to a parsed spec.
 *
 *   undefined/null  -> permissive: external installs allowed (consent gate still applies).
 *   []              -> lockdown:   all EXTERNAL installs blocked (local-only).
 *   non-empty list  -> allowlist:  only sources whose host matches an entry are allowed.
 *   anything else   -> FAIL CLOSED: a malformed policy value blocks the install.
 *
 * Local (filesystem) sources are never "external" and are always allowed — EXCEPT a UNC network
 * path (`\\server\share`), which is remote despite parsing as an "absolute"/local-kind spec and is
 * therefore subject to the policy.
 */
function evaluateSourceAllowed(parsed: ParsedSpec, strict: StrictKnownRegistries): SourceVerdict {
  const target = parsed.target || parsed.raw || '';
  const unc = parsed.kind === 'local' && isUncPath(target);
  if (parsed.kind === 'local' && !unc) return { allowed: true, reason: null };

  if (strict === undefined || strict === null) return { allowed: true, reason: null };
  if (!Array.isArray(strict)) {
    // A security policy must never be silently ignored when it is the wrong type (e.g. a
    // string `"[]"` from a hand-edited config). Fail closed.
    return {
      allowed: false,
      reason:
        'capabilities.strict_known_registries must be an array (or null/unset); refusing the install on a malformed policy value',
    };
  }

  if (strict.length === 0) {
    return {
      allowed: false,
      reason:
        'capabilities.strict_known_registries is [] — all external capability installs are disabled. ' +
        'Install from a local path, or add an allowed host to the list.',
    };
  }

  // npm specs carry no host; the "registry" is npm itself. Treat the allowlist token "npm" as
  // permitting the npm source kind.
  if (parsed.kind === 'npm') {
    if (strict.some((e) => typeof e === 'string' && e.trim().toLowerCase() === 'npm')) {
      return { allowed: true, reason: null };
    }
    return {
      allowed: false,
      reason: `npm source is not in capabilities.strict_known_registries (add "npm" to allow it)`,
    };
  }

  const host = unc ? uncHost(target) : specHost(parsed);
  if (hostMatchesAllowlist(host, strict)) return { allowed: true, reason: null };
  return {
    allowed: false,
    reason: `source host "${host || '(unparseable)'}" is not in capabilities.strict_known_registries`,
  };
}

// ---------------------------------------------------------------------------
// engines.gsd hard gate + compatVersions downgrade
// ---------------------------------------------------------------------------

/**
 * Hard-gate a manifest against the running host version via engines.gsd, consulting
 * compatVersions for a graceful-downgrade target when the current version is incompatible.
 */
function checkEngines(manifest: CapabilityManifest, hostVersion: string): EnginesVerdict {
  const engines = manifest.engines;
  let range: string | null = null;
  if (engines && typeof engines === 'object' && !Array.isArray(engines)) {
    const g = (engines as Record<string, unknown>)['gsd'];
    if (typeof g === 'string' && g) range = g;
  }

  if (!range) return { compatible: true, range: null, satisfiedBy: 'unconstrained' };

  if (semverMod.semverSatisfies(hostVersion, range)) {
    return { compatible: true, range, satisfiedBy: 'engines' };
  }

  // Current version is incompatible — look for a compatVersions entry that works, picking the
  // newest such capability version (best graceful downgrade).
  const compat = manifest.compatVersions;
  let best: string | undefined;
  if (compat && typeof compat === 'object' && !Array.isArray(compat)) {
    for (const [capVer, gsdRange] of Object.entries(compat as Record<string, unknown>)) {
      if (typeof gsdRange !== 'string' || !gsdRange) continue;
      if (!semverMod.semverSatisfies(hostVersion, gsdRange)) continue;
      if (best === undefined || semverMod.isSemverNewer(capVer, best)) best = capVer;
    }
  }

  if (best !== undefined) {
    return { compatible: false, range, satisfiedBy: 'compatVersions', downgradeTo: best };
  }
  return { compatible: false, range, satisfiedBy: null };
}

// ---------------------------------------------------------------------------
// Composite install verdict
// ---------------------------------------------------------------------------

/**
 * Compose the full install trust verdict: source policy + reserved-namespace + engines gate +
 * executable-surface disclosure. `allowed` is true only when no gate blocks; `requiresConsent`
 * is true when allowed AND the capability ships any executable surface.
 *
 * engines.gsd is also enforced inside resolveCapabilitySource at resolve time; re-checking here
 * is defense-in-depth and lets callers surface a compatVersions downgrade hint.
 */
function evaluateInstallTrust(args: InstallTrustArgs): InstallTrustVerdict {
  const { parsed, manifest, stagedDir, strictKnownRegistries, hostVersion, resolveHost } = args;
  const blockReasons: string[] = [];

  const src = evaluateSourceAllowed(parsed, strictKnownRegistries);
  if (!src.allowed && src.reason) blockReasons.push(src.reason);

  const ns = checkReservedNamespace(manifest.id);
  if (ns.reserved) {
    blockReasons.push(
      `capability id "${asString(manifest.id)}" uses the reserved namespace "${ns.namespace}" — ` +
        'reserved for first-party capabilities',
    );
  }

  const engines = checkEngines(manifest, hostVersion);
  if (!engines.compatible) {
    const hint = engines.downgradeTo
      ? ` (compatVersions offers ${engines.downgradeTo} for this host)`
      : '';
    blockReasons.push(
      `capability requires engines.gsd "${engines.range}" but host is ${hostVersion}${hint}`,
    );
  }

  // #2796: resolveHost is optional and, when supplied, discloses the REAL destination of an
  // openai-http reviewer lane to the human at install/upgrade time — it never affects the
  // consent-binding signature (disclosureSignature never reads resolvedHost; design constraint 2).
  const disclosure = discloseExecutableSurfaces(manifest, stagedDir, resolveHost);

  // A manifest that declares a hook script or command module NOT present in the staged bundle
  // (missing, or escaping the bundle via an absolute/`..` path) is rejected: such an artifact
  // would run from outside the integrity-pinned, reversible install root. Only enforced when a
  // stagedDir was provided to existence-check against.
  if (stagedDir && disclosure.missingArtifacts.length > 0) {
    blockReasons.push(
      `capability declares executable artifacts not present in the staged bundle (or escaping it): ${disclosure.missingArtifacts.join(', ')}`,
    );
  }

  const allowed = blockReasons.length === 0;
  const requiresConsent = allowed && disclosure.hasExecutable;
  return { allowed, requiresConsent, disclosure, engines, blockReasons };
}

// ---------------------------------------------------------------------------
// Executable-set change detection (auto-update re-prompt trigger)
// ---------------------------------------------------------------------------

/**
 * Serialize a value to JSON with object keys RECURSIVELY SORTED, so the result is stable under key
 * reordering. Used to fold an MCP server's `env` map into the disclosure signature: ADDING or
 * CHANGING any env entry changes the signature (forces re-consent), but merely REORDERING the keys
 * does NOT (no false re-prompt). TRUST-2 (#1459).
 *
 * TOTAL (#2796, matrix C5c/E2): a value declared inside an unvalidated manifest — e.g. a reviewer
 * lane's `invoke.args` — may contain a BigInt (which `JSON.stringify` throws on) or a circular
 * reference (which unguarded recursion stack-overflows on). Both are handled without throwing:
 * a BigInt renders as its decimal string; a cycle (an object that is its OWN ancestor in the current
 * recursion path — tracked via `seen`, added before recursing into children and removed once fully
 * processed) renders as the literal string `"[Circular]"`. Neither case is reachable for the golden
 * hooks/mods/mcp fixtures this phase's byte-identity tests pin down, so their output is unaffected.
 */
function stableJson(value: unknown, seen?: Set<unknown>): string {
  if (typeof value === 'bigint') return JSON.stringify(`${value.toString()}n`);
  if (value === null || typeof value !== 'object') {
    try {
      return JSON.stringify(value) ?? 'null';
    } catch {
      // A non-object value whose serialization still throws (defensive; JSON.stringify does not
      // throw for any other typeof today, but this keeps the contract TOTAL against future engines).
      return 'null';
    }
  }
  const seenSet = seen ?? new Set<unknown>();
  if (seenSet.has(value)) return '"[Circular]"';
  try {
    seenSet.add(value);
    if (Array.isArray(value)) {
      return `[${value.map((v) => stableJson(v, seenSet)).join(',')}]`;
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k], seenSet)}`).join(',')}}`;
  } catch {
    // A Proxy with a throwing trap, or a getter that throws on read — never propagate (matrix C5).
    return '"[unserializable]"';
  } finally {
    seenSet.delete(value);
  }
}

function disclosureSignature(d: Disclosure): string {
  // TRUST2-1 (#1459): build EVERY surface line via stableJson of an ARRAY of its components, so each
  // component is encoded — a `:`-delimited concatenation let a delimiter inside a component (e.g. an
  // mcp name `x:a` vs command `b`) collide with a different decomposition. JSON-encoding every
  // component makes each line an injective function of its components (no delimiter injection).
  const hooks = d.hooks.map((h) => stableJson(['hook', h.event, h.script])).sort();
  // TRUST2-3: include the router (which exported fn runs) so retargeting it forces re-consent.
  const mods = d.commandModules.map((m) => stableJson(['mod', m.family, m.module, m.router || ''])).sort();
  // Include transport + command + RAW args + url + headers + env + cwd + the FULL declared config so a
  // version that:
  //   - swaps the stdio executable it runs (command/args), OR
  //   - changes the env it runs with (e.g. NODE_OPTIONS=--require evil.js), OR
  //   - changes the cwd it runs in, OR
  //   - (TRUST2-2) swaps the transport/url/headers of a non-stdio (http/sse) server, OR
  //   - (TRUST2-4) changes a NON-STRING arg the host still receives, OR
  //   - (finding 5) changes ANY OTHER declared field the writer persists (a future envFile/workingDir/
  //     launch option NOT in the explicit whitelist above)
  // is detected as a changed surface (forces re-consent). The explicit fields are kept FIRST for
  // readability/stability; `rawConfig` is the completeness backstop. All are STABLE-encoded (recursively
  // key-sorted JSON) so any add/change forces re-consent while a pure key reorder does NOT (no false
  // re-prompt).
  const mcp = d.mcpServers
    .map((s) =>
      stableJson([
        'mcp',
        s.name,
        s.transport || '',
        s.command,
        s.rawArgs || [],
        s.url || '',
        s.headers || {},
        s.env || {},
        s.cwd || '',
        // Finding 5: the FULL declared config — completeness so any persisted field change re-consents.
        s.rawConfig || {},
      ]),
    )
    .sort();
  // ADR-2782 D5 (#2796): fold in slug/transport/binary/rawArgs/hostConfigKey/promptChannel/handler —
  // every field that changes WHAT runs, WHERE it sends data, or WHAT CODE post-processes its output
  // (matrix A3–A9). Deliberately ABSENT from this line: `reviewsSection` and `timeoutFloorMs` (matrix
  // A10/A13 — cosmetic fields; folding them in would force a re-consent prompt that carries no
  // security information, training users to click through) and the RESOLVED host (design constraint
  // 2 — the loader has no config resolver and must compute the SAME signature as the lifecycle, or a
  // resolver-bearing caller and a resolver-less caller would permanently disagree on one manifest's
  // signature).
  const lanes = d.reviewerLanes
    .map((l) =>
      stableJson(['lane', l.slug, l.transport, l.binary, l.rawArgs || [], l.hostConfigKey, l.promptChannel, l.handler]),
    )
    .sort();
  // D4.5 (the highest-consequence line in this phase): the lane element is appended ONLY when at
  // least one lane is declared. A lane-free manifest's signature stays BYTE-IDENTICAL to before this
  // class existed (matrix A1a/A1b/A1c) — appending unconditionally would change every already-
  // installed capability's signature and re-prompt every user for every capability on next upgrade,
  // whether or not they use any reviewer lane at all.
  return lanes.length > 0 ? JSON.stringify([hooks, mods, mcp, lanes]) : JSON.stringify([hooks, mods, mcp]);
}

/**
 * Did the executable surface set change between two versions? Auto-update must re-prompt for
 * consent when it did (the user consented to one set of executable surfaces, not another).
 */
function executableSetChanged(oldD: Disclosure, newD: Disclosure): boolean {
  return disclosureSignature(oldD) !== disclosureSignature(newD);
}

/**
 * THE single source of truth for the consent-binding signature of a capability manifest: run
 * `discloseExecutableSurfaces` then `disclosureSignature`. Both the loader (which checks whether a
 * previously-consented project cap still matches) and the lifecycle (which records the consent)
 * compute the binding through THIS helper so they can never drift. `stagedDir` is forwarded for
 * artifact existence-checking; the signature itself is over the executable SET (hooks/mods/mcp incl.
 * env/cwd), not the missingArtifacts list, so it is a stable key regardless of the stagedDir.
 */
function signatureForManifest(manifest: CapabilityManifest, stagedDir?: string): string {
  return disclosureSignature(discloseExecutableSurfaces(manifest, stagedDir));
}

// ---------------------------------------------------------------------------
// Human-readable consent prompt
// ---------------------------------------------------------------------------

/** Max characters of an env VALUE shown in the human consent prompt before it is truncated. */
const ENV_VALUE_MAX = 60;

/** Truncate a long env value for the human prompt (the full value is still in the signature). */
function truncateEnvValue(v: string): string {
  if (typeof v !== 'string') return '';
  return v.length > ENV_VALUE_MAX ? `${v.slice(0, ENV_VALUE_MAX)}… (${v.length} chars)` : v;
}

/**
 * Render a disclosure as consent-prompt lines. Returned as an array so the CLI/runtime edge can
 * format it; the lib never writes to stdout.
 */
function summarizeDisclosure(disclosure: Disclosure): string[] {
  const lines: string[] = [];
  if (!disclosure.hasExecutable) {
    lines.push('This capability ships no executable surfaces (declarative only).');
    return lines;
  }
  lines.push('This capability ships executable surfaces that will run in your agent runtime:');
  if (disclosure.hooks.length > 0) {
    lines.push(`  hooks (${disclosure.hooks.length}): run as runtime hook commands`);
    for (const h of disclosure.hooks) {
      lines.push(`    - ${h.event || '(event?)'} -> ${h.script}`);
    }
  }
  if (disclosure.commandModules.length > 0) {
    lines.push(
      `  command modules (${disclosure.commandModules.length}): require()'d into the GSD CLI process`,
    );
    for (const m of disclosure.commandModules) {
      // TRUST2-3 (#1459): show the router (which exported fn runs) so the user consents to the exact entry point.
      const routerSuffix = m.router ? ` [router: ${m.router}]` : '';
      lines.push(`    - ${m.family || '(family?)'} -> ${m.module}${routerSuffix}`);
    }
  }
  if (disclosure.mcpServers.length > 0) {
    lines.push(`  MCP servers (${disclosure.mcpServers.length}): spawned/connected by the host runtime`);
    for (const s of disclosure.mcpServers) {
      // TRUST2-2 (#1459): a non-stdio (http/sse) server connects to a URL; disclose the endpoint, not
      // a (nonexistent) command. A stdio server discloses command + args as before.
      const isRemote = (s.transport === 'http' || s.transport === 'sse') || (!s.command && !!s.url);
      if (isRemote) {
        const t = s.transport || 'http';
        lines.push(`    - ${s.name} -> [${t}] ${s.url || '(no url declared)'}`);
        // Header VALUES are redacted in the human summary (they may carry secrets); only the KEY set
        // is shown. The full values ARE in the signature, so a value change forces re-consent.
        const hdrKeys = s.headers ? Object.keys(s.headers) : [];
        if (hdrKeys.length > 0) {
          lines.push(`        headers: ${hdrKeys.map((k) => `${k}=<redacted>`).join(', ')}`);
        }
      } else {
        const cmd = [s.command, ...s.argv].filter(Boolean).join(' ');
        lines.push(`    - ${s.name} -> ${cmd || '(no command declared)'}`);
      }
      // TRUST-2 (#1459): env can change WHAT runs without touching the command, so show each env key
      // and its (truncated) value — the user is consenting to this exact environment.
      const envKeys = s.env ? Object.keys(s.env) : [];
      if (envKeys.length > 0) {
        lines.push(`        env: ${envKeys.map((k) => `${k}=${truncateEnvValue(s.env[k])}`).join(', ')}`);
      }
      if (s.cwd) lines.push(`        cwd: ${s.cwd}`);
    }
  }
  if (disclosure.reviewerLanes.length > 0) {
    lines.push(`  reviewer lane (${disclosure.reviewerLanes.length}): an external reviewer receives plan/review data on every run`);
    for (const l of disclosure.reviewerLanes) {
      // B1/B2/B3/B4: disclose binary+args for a spawn lane, or hostConfigKey+resolved destination
      // (flagged local when applicable, never omitted as "safe") for an openai-http lane — never
      // curl/the transport name alone, which would be true and useless (design B2).
      // Branch on the DECLARED SHAPE, not on an exact transport string. A lane
      // whose transport is mis-cased or unrecognised still has a hostConfigKey,
      // and falling through to the spawn branch would print "(no binary
      // declared)" for a lane that in fact egresses to a live remote host —
      // understating the disclosure precisely when it matters. Disclosure runs
      // BEFORE validation, so a non-canonical transport does reach this code.
      if (l.transport === 'openai-http' || (!l.binary && l.hostConfigKey)) {
        const localTag = l.isLocalDestination ? ' [local]' : '';
        lines.push(`    - ${l.slug || '(slug?)'} -> [openai-http] ${l.hostConfigKey || '(hostConfigKey?)'} => ${l.resolvedHost}${localTag}`);
      } else {
        // Render the RAW declared args, not the string-filtered view. The raw
        // array is what the host receives and what the consent signature binds,
        // so a non-string member that is invisible here is a surface the user
        // consented to without being shown — the opposite of the disclosure's
        // whole purpose.
        const cmd = [l.binary, ...l.rawArgs.map(renderArgForHuman)].filter(Boolean).join(' ');
        lines.push(`    - ${l.slug || '(slug?)'} -> ${cmd || '(no binary declared)'}`);
      }
      if (l.handler) lines.push(`        handler: ${l.handler}`);
      lines.push(`        sends: ${l.egressPayloadClasses.join(', ')}`);
    }
  }
  if (disclosure.missingArtifacts.length > 0) {
    lines.push('  WARNING — declared artifacts not found in the staged bundle:');
    for (const a of disclosure.missingArtifacts) {
      lines.push(`    - ${a}`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export = {
  RESERVED_NAMESPACES,
  discloseExecutableSurfaces,
  // #2796: the reviewer-lane collector, exported for independent testability (ADR-2782's own
  // argument for extracting per-class collectors rather than growing the switch inline).
  collectReviewerLaneSurfaces,
  checkReservedNamespace,
  evaluateSourceAllowed,
  checkEngines,
  evaluateInstallTrust,
  executableSetChanged,
  summarizeDisclosure,
  // #1459: the consent-binding signature (single source of truth for loader + lifecycle consent).
  disclosureSignature,
  signatureForManifest,
  // #2796: the non-blank unresolved-host marker and the named egress payload classes, exported so
  // tests can assert exact equality rather than a loose substring match.
  UNRESOLVED_HOST_MARKER,
  EGRESS_PAYLOAD_CLASSES,
};
