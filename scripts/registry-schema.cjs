'use strict';

/**
 * scripts/registry-schema.cjs — pure schema/vocab constants + validation +
 * markdown-generation logic for the two third-party discoverability catalogs
 * (issue #2182):
 *
 *   - `docs/registries/capabilities.json`  → "GSD Community Capability Registry"
 *   - `docs/registries/eos.json`           → "GSD EoS Registry" (PR2)
 *
 * The vocabulary constants below are ADDITIVE CONTRACTS that track the
 * runtime/ADR closed vocabularies they describe — they are a documentation-
 * registry-scoped mirror, not the runtime source of truth:
 *
 *   - `LOOP_POINTS` mirrors ADR-857 "Loop Extension Points (the 12)"
 *     (docs/adr/857-capability-system.md §"Loop Extension Points (the 12)").
 *     The canonical runtime set lives in `src/loop-resolver.cts`
 *     (`CANONICAL_POINTS` / `CANONICAL_POINTS_FALLBACK`, derived from
 *     `loop-host-contract.cjs`) — changing that set requires updating this
 *     list too, since a registry entry's `loopExtensionPoints` describes
 *     which of those 12 points a third-party capability extends.
 *   - `HOOK_KINDS` mirrors ADR-857 Decision 4 "three hook kinds": `step`
 *     (runs as its own sequenced unit), `contribution` (injects into the
 *     core step's prompt/context), `gate` (checks and optionally blocks).
 *   - `INTERFACE_POINTS` mirrors ADR-1239 "The six interface points" (the
 *     Host-Integration Interface integration surface): command/workflow
 *     invocation, agent dispatch, model invocation, lifecycle hooks,
 *     state+config IO, artifact surface.
 *   - `PROFILES` mirrors ADR-1239 "Host-capability profiles (negotiation
 *     baselines)": `programmatic-cli`, `declarative-cli`, `ide`.
 *   - `AXES` mirrors ADR-1239 "the eight negotiated axes" (the negotiated
 *     capability schema exchanged at `initialize`): `embeddingMode`,
 *     `commandSurface`, `dispatch`, `modelMode`, `hookBus`, `stateIO`,
 *     `transport`, `runtime`. Seven of the eight are closed enums here;
 *     `dispatch` is ADR-1239's structured negotiated object
 *     (`{ namedDispatch, nested, maxDepth, background, subagentToolkit }`) —
 *     this registry accepts a free-form human summary string instead, so it
 *     carries the `AXES_FREE_STRING` sentinel rather than an enum array.
 *     `OPTIONAL_AXES` adds one further, OPTIONAL key on top of those eight:
 *     `effortSurface` (ADR-1239 amendment #2481). An entry may omit it
 *     (every entry published before the amendment stays valid) or declare
 *     it as `argv` | `none`, mirroring `HOST_INTEGRATION_AXES.effortSurface`
 *     in `src/host-integration.cts`.
 *   - `CAPABILITY_REQUIRED` / `EOS_REQUIRED` mirror the required top-level
 *     fields for each entry type, including `enginesGsd` (ADR-1244 D1
 *     "Versioned capability manifest" — the `engines.gsd` semver-range gate,
 *     modelled on VS Code's `engines.vscode`).
 *
 * This module is pure — no `fs`/`process`/child-process access — so tests
 * can `require()` it directly and assert on structured return values.
 * `scripts/validate-registry.cjs` and `scripts/gen-registry.cjs` are the thin
 * CLI wrappers that perform I/O around these functions.
 */

// ─── ADR-857 "Loop Extension Points (the 12)" ────────────────────────────────
const LOOP_POINTS = Object.freeze([
  'discuss:pre',
  'discuss:post',
  'plan:pre',
  'plan:post',
  'execute:pre',
  'execute:wave:pre',
  'execute:wave:post',
  'execute:post',
  'verify:pre',
  'verify:post',
  'ship:pre',
  'ship:post',
]);

// ─── ADR-857 Decision 4 — three hook kinds ───────────────────────────────────
const HOOK_KINDS = Object.freeze(['step', 'contribution', 'gate']);

// ─── ADR-1239 "The six interface points" ─────────────────────────────────────
const INTERFACE_POINTS = Object.freeze(['command', 'dispatch', 'model', 'hooks', 'state', 'artifact']);

// ─── ADR-1239 "Host-capability profiles (negotiation baselines)" ────────────
const PROFILES = Object.freeze(['programmatic-cli', 'declarative-cli', 'ide']);

// Sentinel marking an AXES entry as a free-form descriptive string rather than
// a closed enum array. `Array.isArray(AXES_FREE_STRING)` is false, so callers
// can branch on `Array.isArray(AXES[key])` vs `AXES[key] === AXES_FREE_STRING`
// without risking confusion with a real enum value.
const AXES_FREE_STRING = Symbol('registry-schema.AXES_FREE_STRING');

// ─── ADR-1239 "the eight negotiated axes" ────────────────────────────────────
const AXES = Object.freeze({
  embeddingMode: Object.freeze(['imperative', 'declarative']),
  commandSurface: Object.freeze(['slash-file', 'slash-programmatic', 'slash-toml', 'palette', 'prose-only']),
  dispatch: AXES_FREE_STRING,
  modelMode: Object.freeze(['active', 'passive']),
  hookBus: Object.freeze(['host', 'engine', 'none']),
  stateIO: Object.freeze(['filesystem', 'sandboxed-storage', 'session-log-append']),
  transport: Object.freeze(['mcp', 'native-extension']),
  runtime: Object.freeze(['node', 'bun', 'sandboxed-web', 'python', 'go', 'rust', 'electron', 'other']),
});

// ─── ADR-1239 amendment #2481 — one additional, OPTIONAL negotiated axis ─────
// `effortSurface` was added to the runtime-descriptor vocabulary AFTER the
// original eight (`HOST_INTEGRATION_AXES.effortSurface` in
// `src/host-integration.cts`). It is kept OPTIONAL here — not folded into
// `AXES` — because registry entries mirror their upstream
// `registry/eos-entry.json` byte-for-byte, and requiring it would
// retroactively invalidate every entry published before the amendment.
// Values must match `HOST_INTEGRATION_AXES.effortSurface` exactly.
const OPTIONAL_AXES = Object.freeze({
  effortSurface: Object.freeze(['argv', 'none']),
});

// ─── Required top-level fields ───────────────────────────────────────────────
const CAPABILITY_REQUIRED = Object.freeze([
  'id',
  'name',
  'type',
  'repo',
  'description',
  'author',
  'license',
  'enginesGsd',
  'install',
  'uninstall',
  'interactions',
  'discussion',
]);

const EOS_REQUIRED = Object.freeze([
  'id',
  'name',
  'type',
  'repo',
  'description',
  'author',
  'license',
  'enginesGsd',
  'install',
  'uninstall',
  'interactions',
  'discussion',
  'protocolVersion',
]);

// Escape Markdown inline metacharacters in UNTRUSTED free text so a registry
// entry cannot inject links/tables/code-spans into the generated catalog.
// Neutralizes: link hijack ([ ] ( )), table breakout (|), code span (`),
// and backslash. Newlines are collapsed to a single space (inline contexts).
function mdInline(value) {
  return String(value).replace(/[\\`*_[\]()|~<>]/g, '\\$&').replace(/[\r\n]+/g, ' ');
}
// A fenced-code fence guaranteed longer than any backtick run in `value`, so a
// value containing ``` cannot escape the block (CommonMark rule). Min length 3.
function fenceFor(value) {
  const runs = String(value).match(/`+/g) || [];
  const longest = runs.reduce((m, r) => Math.max(m, r.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

// A single `engines.gsd` range clause: optional comparison operator, optional
// leading `v`, exactly three dot-separated numeric segments, optional
// prerelease (`-...`) and build (`+...`) suffixes. Operator alternation order
// matters — `>=`/`<=` must be tried before `>`/`<` or the longer operator
// would never match.
const GSD_RANGE_CLAUSE_RE = /^(>=|<=|>|<|=|\^|~)?v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/**
 * Validate the SHAPE of an `engines.gsd`-style semver range string (ADR-1244
 * D1). Self-contained — no `semver` dependency, modelled on the constraint
 * parsing in `scripts/check-env.cjs` (`satisfiesConstraint`), but this
 * function validates that the range is well-formed rather than comparing it
 * against a concrete version.
 *
 * @param {string} range
 * @returns {boolean}
 */
function isValidGsdRange(range) {
  if (typeof range !== 'string') return false;
  const trimmed = range.trim();
  if (trimmed === '') return false;
  if (trimmed === '*') return true;
  const clauses = trimmed.split(/\s+/);
  return clauses.length > 0 && clauses.every((clause) => clause !== '' && GSD_RANGE_CLAUSE_RE.test(clause));
}

/**
 * Validate the `interactions` sub-object for a capability entry.
 *
 * @param {object} interactions
 * @param {(field: string, reason: string) => void} addError
 * @returns {void}
 */
function validateCapabilityInteractions(interactions, addError) {
  const allowedKeys = new Set([
    'loopExtensionPoints',
    'hookKinds',
    'configKeys',
    'requires',
    'runtimeCompat',
    'produces',
    'consumes',
  ]);
  for (const key of Object.keys(interactions)) {
    if (!allowedKeys.has(key)) addError(`interactions.${key}`, 'unknown field');
  }

  for (const field of ['loopExtensionPoints', 'hookKinds']) {
    if (interactions[field] === undefined) addError(`interactions.${field}`, 'missing required field');
  }

  if (interactions.loopExtensionPoints !== undefined) {
    const v = interactions.loopExtensionPoints;
    if (!Array.isArray(v) || v.length === 0 || !v.every((x) => LOOP_POINTS.includes(x))) {
      addError('interactions.loopExtensionPoints', 'must be a non-empty array of valid loop extension points');
    }
  }

  if (interactions.hookKinds !== undefined) {
    const v = interactions.hookKinds;
    if (!Array.isArray(v) || !v.every((x) => HOOK_KINDS.includes(x))) {
      addError('interactions.hookKinds', 'must be an array of valid hook kinds');
    }
  }

  for (const field of ['configKeys', 'requires', 'runtimeCompat', 'produces', 'consumes']) {
    if (interactions[field] === undefined) continue;
    const v = interactions[field];
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
      addError(`interactions.${field}`, 'must be an array of strings');
    }
  }
}

/**
 * Validate the `interactions` sub-object for an eos entry.
 *
 * @param {object} interactions
 * @param {(field: string, reason: string) => void} addError
 * @returns {void}
 */
function validateEosInteractions(interactions, addError) {
  const allowedKeys = new Set(['interfacePoints', 'profile', 'axes']);
  for (const key of Object.keys(interactions)) {
    if (!allowedKeys.has(key)) addError(`interactions.${key}`, 'unknown field');
  }

  for (const field of ['interfacePoints', 'profile', 'axes']) {
    if (interactions[field] === undefined) addError(`interactions.${field}`, 'missing required field');
  }

  if (interactions.interfacePoints !== undefined) {
    const v = interactions.interfacePoints;
    if (!Array.isArray(v) || v.length === 0 || !v.every((x) => INTERFACE_POINTS.includes(x))) {
      addError('interactions.interfacePoints', 'must be a non-empty array of valid interface points');
    }
  }

  if (interactions.profile !== undefined) {
    if (typeof interactions.profile !== 'string' || !PROFILES.includes(interactions.profile)) {
      addError('interactions.profile', 'must be one of the valid negotiation profiles');
    }
  }

  if (interactions.axes !== undefined) {
    const axes = interactions.axes;
    if (typeof axes !== 'object' || axes === null || Array.isArray(axes)) {
      addError('interactions.axes', 'axes must be an object');
    } else {
      const requiredKeys = Object.keys(AXES);
      const optionalKeys = Object.keys(OPTIONAL_AXES);
      const actualKeys = Object.keys(axes);
      const actualKeySet = new Set(actualKeys);

      // Every AXES key is mandatory; an extra key is tolerated ONLY when it is
      // a recognized OPTIONAL_AXES key (currently just `effortSurface`) — any
      // other extra key is still rejected as unknown.
      const missingRequiredKeys = requiredKeys.filter((k) => !actualKeySet.has(k));
      const unknownKeys = actualKeys.filter((k) => !requiredKeys.includes(k) && !optionalKeys.includes(k));

      if (missingRequiredKeys.length > 0) {
        addError('interactions.axes', `axes is missing required key(s): ${missingRequiredKeys.join(', ')}`);
      }
      if (unknownKeys.length > 0) {
        addError('interactions.axes', `axes has unknown key(s): ${unknownKeys.join(', ')}`);
      }

      // Only validate individual values once the key set itself is sound —
      // mirrors the original gate (values were never checked against a
      // malformed key set either).
      if (missingRequiredKeys.length === 0 && unknownKeys.length === 0) {
        for (const key of actualKeys) {
          // Inline literal guards — CodeQL barrier pattern. Reaching here already
          // implies `key` is one of the nine literal axis names (the unknown-key
          // gate above rejected everything else), so this is unreachable in
          // practice; it is written inline anyway because CodeQL cannot follow
          // that gate across the `.includes()` filter and would otherwise flag
          // the bracket reads below as prototype-pollution sinks.
          if (key === '__proto__') continue;
          if (key === 'constructor') continue;
          if (key === 'prototype') continue;
          const allowedValues = Object.hasOwn(AXES, key) ? AXES[key] : OPTIONAL_AXES[key];
          const v = axes[key];
          if (allowedValues === AXES_FREE_STRING) {
            if (typeof v !== 'string' || v.trim() === '') {
              addError(`interactions.axes.${key}`, 'must be a non-empty string');
            } else if (v.length > 300) {
              addError(`interactions.axes.${key}`, 'exceeds max length 300');
            }
          } else if (typeof v !== 'string' || !allowedValues.includes(v)) {
            addError(`interactions.axes.${key}`, `must be one of the allowed values for ${key}`);
          }
        }
      }
    }
  }
}

/**
 * Validate an array of registry entries against the closed schema for
 * `opts.type` ('capability' | 'eos').
 *
 * @param {object[]} entries
 * @param {{type: 'capability'|'eos'}} opts
 * @returns {{ok: boolean, errors: Array<{index: number, id?: string, field: string, reason: string}>}}
 */
function validateEntries(entries, opts) {
  if (!Array.isArray(entries)) {
    return { ok: false, errors: [{ index: -1, field: '(root)', reason: 'entries must be an array' }] };
  }

  // Entry-count cap: a pathologically large array (e.g. from an automated or
  // malicious PR) is rejected wholesale rather than validated entry-by-entry.
  if (entries.length > 2000) {
    return { ok: false, errors: [{ index: -1, field: '(root)', reason: 'too many entries (max 2000)' }] };
  }

  const required = opts.type === 'eos' ? EOS_REQUIRED : CAPABILITY_REQUIRED;
  const requiredSet = new Set(required);
  const seenIds = new Set();
  const errors = [];

  entries.forEach((entry, index) => {
    const addError = (field, reason) => {
      const err = { index, field, reason };
      if (entry && typeof entry === 'object' && typeof entry.id === 'string') err.id = entry.id;
      errors.push(err);
    };

    // Null/non-object element guard — a malformed array element (null,
    // undefined-via-hole, a primitive, or an array) cannot be destructured by
    // the field checks below, so reject it outright rather than throwing.
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      addError('(entry)', 'entry must be a JSON object');
      return;
    }

    for (const key of Object.keys(entry)) {
      if (!requiredSet.has(key)) addError(key, 'unknown field');
    }

    const missing = new Set();
    for (const field of required) {
      if (entry[field] === undefined) {
        addError(field, 'missing required field');
        missing.add(field);
      }
    }

    // Control-character rejection (defense in depth): `allowTabNewline` widens
    // the reject-set exception for the two shell-snippet fields (install/
    // uninstall), which legitimately contain tabs/newlines; every other free
    // text field disallows ALL C0 control characters plus DEL (incl. \n/\t).
    // Checked via char codes (not a literal control-char regex range) — same
    // approach as capability-validator.cjs's hooks[].matcher check, which
    // avoids tripping ESLint's no-control-regex rule.
    const hasDisallowedControlChar = (v, allowTabNewline) => {
      for (let c = 0; c < v.length; c += 1) {
        const code = v.charCodeAt(c);
        if (allowTabNewline && (code === 0x09 || code === 0x0a)) continue;
        if (code < 0x20 || code === 0x7f) return true;
      }
      return false;
    };
    const checkNoControlChars = (field, allowTabNewline) => {
      if (missing.has(field)) return;
      const v = entry[field];
      if (typeof v !== 'string') return;
      if (hasDisallowedControlChar(v, allowTabNewline)) addError(field, 'must not contain control characters');
    };
    // Length cap: reject oversized fields (untrusted third-party input feeding
    // a committed Markdown catalog should not be allowed to blow up the doc).
    const checkMaxLength = (field, max) => {
      if (missing.has(field)) return;
      const v = entry[field];
      if (typeof v === 'string' && v.length > max) addError(field, `exceeds max length ${max}`);
    };

    if (!missing.has('id')) {
      const id = entry.id;
      if (typeof id !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) {
        addError('id', 'id must be kebab-case');
      }
      if (seenIds.has(id)) {
        addError('id', `duplicate id: ${id}`);
      } else {
        seenIds.add(id);
      }
    }
    checkMaxLength('id', 100);

    for (const field of ['name', 'description', 'author']) {
      if (missing.has(field)) continue;
      const v = entry[field];
      if (typeof v !== 'string' || v.trim() === '') addError(field, 'must be a non-empty string');
      checkNoControlChars(field, false);
    }
    checkMaxLength('name', 120);
    checkMaxLength('author', 120);
    checkMaxLength('description', 1000);

    if (!missing.has('type') && entry.type !== opts.type) {
      addError('type', `type must be "${opts.type}"`);
    }

    if (!missing.has('repo')) {
      if (typeof entry.repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(entry.repo)) {
        addError('repo', 'repo must be in "owner/repo" form');
      }
    }
    checkMaxLength('repo', 100);

    if (!missing.has('license')) {
      const v = entry.license;
      if (typeof v !== 'string' || v.trim() === '' || !/^[A-Za-z0-9.+()\- ]+$/.test(v)) {
        addError('license', 'license must be a non-empty SPDX-like string');
      }
    }
    checkMaxLength('license', 120);

    if (!missing.has('enginesGsd') && !isValidGsdRange(entry.enginesGsd)) {
      addError('enginesGsd', 'enginesGsd must be a valid semver range');
    }
    checkMaxLength('enginesGsd', 100);

    for (const field of ['install', 'uninstall']) {
      if (missing.has(field)) continue;
      const v = entry[field];
      if (typeof v !== 'string' || v.trim() === '') addError(field, 'must be a non-empty string');
      checkNoControlChars(field, true);
    }
    checkMaxLength('install', 2000);
    checkMaxLength('uninstall', 2000);

    if (!missing.has('discussion')) {
      const v = entry.discussion;
      if (typeof v !== 'string' || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/discussions\/\d+$/.test(v)) {
        addError('discussion', 'discussion must be a GitHub discussions URL');
      }
    }
    checkMaxLength('discussion', 300);

    if (!missing.has('interactions')) {
      const interactions = entry.interactions;
      if (typeof interactions !== 'object' || interactions === null || Array.isArray(interactions)) {
        addError('interactions', 'interactions must be an object');
      } else if (opts.type === 'eos') {
        validateEosInteractions(interactions, addError);
      } else {
        validateCapabilityInteractions(interactions, addError);
      }
    }

    if (opts.type === 'eos' && !missing.has('protocolVersion')) {
      if (!Number.isInteger(entry.protocolVersion) || entry.protocolVersion < 1) {
        addError('protocolVersion', 'protocolVersion must be an integer >= 1');
      }
    }
  });

  return { ok: errors.length === 0, errors };
}

/**
 * Render the deterministic Markdown document for a registry.
 *
 * @param {object[]} entries
 * @param {{type: 'capability'|'eos', sourceFile?: string}} opts
 * @returns {string}
 */
function renderMarkdown(entries, opts) {
  const sorted = [...entries].sort((a, b) => {
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
  const isEos = opts.type === 'eos';
  const lines = [];

  lines.push(
    `<!-- GENERATED by scripts/gen-registry.cjs from docs/registries/${opts.sourceFile} — do not edit by hand; run \`npm run gen:registry\` -->`,
  );
  lines.push('');
  lines.push(isEos ? '# GSD EoS Registry' : '# GSD Community Capability Registry');
  lines.push('');
  lines.push(
    "> **Not an endorsement.** Inclusion means only that a maintainer merged a PR linking the author's repository — GSD has not reviewed, tested, or verified any listing. See the [registry README](./README.md).",
  );
  lines.push('');
  lines.push(`_To add your ${isEos ? 'integration' : 'capability'}, see the [registry README](./README.md)._`);
  lines.push('');

  if (sorted.length === 0) {
    lines.push('_No entries yet — be the first: see [README](./README.md)._');
    return `${lines.join('\n')}\n`;
  }

  lines.push('| Name | What it is | Latest release | GSD compat | Discussion |');
  lines.push('|---|---|---|---|---|');
  for (const entry of sorted) {
    // entry.repo/enginesGsd/discussion are regex-constrained (validateEntries)
    // and used as link DESTINATIONS / badge URLs here — never mdInline those,
    // it would corrupt the URL. entry.name/description are untrusted free-text
    // link TEXT / body copy and MUST be escaped.
    lines.push(
      `| [${mdInline(entry.name)}](https://github.com/${entry.repo}) | ${mdInline(entry.description)} | ` +
        `![release](https://img.shields.io/github/v/release/${entry.repo}?sort=semver&include_prereleases) | ` +
        `\`${entry.enginesGsd}\` | [discuss](${entry.discussion}) |`,
    );
  }
  lines.push('');

  sorted.forEach((entry, i) => {
    const interactions = entry.interactions || {};

    lines.push(`## ${mdInline(entry.name)}`);
    lines.push(
      `- **Repository:** https://github.com/${entry.repo} — [latest release](https://github.com/${entry.repo}/releases/latest)`,
    );
    lines.push(`- **What it is:** ${mdInline(entry.description)}`);
    lines.push(`- **Author:** ${mdInline(entry.author)}`);

    if (isEos) {
      // Required AXES keys always render, in their fixed order; an OPTIONAL_AXES
      // key (e.g. `effortSurface`) renders ONLY when the entry actually carries
      // it — an entry that omits it must render byte-identical to before
      // OPTIONAL_AXES existed (no `effortSurface=undefined` noise).
      const presentOptionalKeys = Object.keys(OPTIONAL_AXES).filter(
        (key) => interactions.axes && Object.hasOwn(interactions.axes, key),
      );
      const axesSummary = [...Object.keys(AXES), ...presentOptionalKeys]
        .map((key) => `${key}=${interactions.axes ? interactions.axes[key] : undefined}`)
        .join(', ');
      const summary =
        `Interface points: ${(interactions.interfacePoints || []).join(', ')}; ` +
        `profile: ${interactions.profile}; protocol v${entry.protocolVersion}; axes: ${axesSummary}`;
      // Single mdInline pass over the fully-assembled summary: none of the
      // literal separator text above contains Markdown metacharacters, so
      // this equally neutralizes every embedded free-text/vocab value
      // (notably interactions.axes.dispatch, a free-form untrusted string).
      lines.push(`- **Every interaction with GSD:** ${mdInline(summary)}`);
    } else {
      let summary =
        `Loop Extension Points: ${(interactions.loopExtensionPoints || []).join(', ')}; ` +
        `hook kinds: ${(interactions.hookKinds || []).join(', ')}`;
      for (const field of ['configKeys', 'requires', 'runtimeCompat', 'produces', 'consumes']) {
        const v = interactions[field];
        if (Array.isArray(v) && v.length > 0) summary += `; ${field}: ${v.join(', ')}`;
      }
      // configKeys/requires/runtimeCompat/produces/consumes are untrusted
      // free-form strings (schema only requires "array of strings") — same
      // single-pass mdInline rationale as the eos branch above.
      lines.push(`- **Every interaction with GSD:** ${mdInline(summary)}`);
    }

    // Code-span content (install/uninstall) is NOT mdInline-escaped — it is a
    // verbatim shell snippet, not inline prose. Instead each block picks a
    // fence strictly longer than any backtick run inside its own content, so
    // an embedded ``` cannot prematurely close the fence (CommonMark rule).
    const installFence = fenceFor(entry.install);
    lines.push('- **Install:**');
    lines.push(`${installFence}sh`);
    lines.push(entry.install);
    lines.push(installFence);
    const uninstallFence = fenceFor(entry.uninstall);
    lines.push('- **Uninstall:**');
    lines.push(`${uninstallFence}sh`);
    lines.push(entry.uninstall);
    lines.push(uninstallFence);

    lines.push(
      isEos
        ? `- **GSD compatibility:** \`${entry.enginesGsd}\`, protocol v${entry.protocolVersion}`
        : `- **GSD compatibility:** \`${entry.enginesGsd}\``,
    );
    lines.push(`- **License:** ${mdInline(entry.license)}`);
    lines.push(`- **Discussion / ranking:** ${entry.discussion}`);

    if (i < sorted.length - 1) lines.push('');
  });

  return `${lines.join('\n')}\n`;
}

module.exports = {
  LOOP_POINTS,
  HOOK_KINDS,
  INTERFACE_POINTS,
  PROFILES,
  AXES,
  OPTIONAL_AXES,
  AXES_FREE_STRING,
  CAPABILITY_REQUIRED,
  EOS_REQUIRED,
  isValidGsdRange,
  validateEntries,
  renderMarkdown,
};
