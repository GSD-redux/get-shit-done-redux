'use strict';

/**
 * capability-validator.cjs — shared, runtime-callable capability validator.
 *
 * Extracted from scripts/gen-capability-registry.cjs per ADR-1244 D2 so that
 * both the build-time generator and the runtime overlay loader can require the
 * validator WITHOUT pulling in the generator's build-time-only machinery
 * (ExitError, config-schema.manifest.json, install-profiles.cjs, clusters.cjs,
 * gen-loop-host-contract.cjs, etc.).
 *
 * This is a COMMITTED plain .cjs (not built from .cts) so it is available on a
 * fresh worktree before `npm run build:lib` has run.
 */

const path = require('node:path');

const { LOOP_HOST_CONTRACT } = require('./loop-host-contract.cjs');

// ─── Shared schema-version constant ──────────────────────────────────────────

const SCHEMA_VERSION = '1';

// ─── Loop Host Contract ───────────────────────────────────────────────────────

// Canonical point order — explicit constant (do NOT rely on Set insertion order).
// Used for point-ordering semantics in consumes-satisfiability validation and topo-sort.
const POINT_ORDER = [
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
];

// C1: Artifact availability — host-produced artifacts become available at their step's :post
// point. Build a map: artifact → earliest POINT_ORDER index at which it is available.
// (discuss produces CONTEXT.md → discuss:post = index 1;
//  plan produces PLAN.md → plan:post = index 3;
//  execute produces SUMMARY.md → execute:post = index 7;
//  verify produces UAT.md → verify:post = index 9)
//
// NOTE: this map covers ONLY host artifacts. Hook-produced artifacts are handled per-run
// during consumes-satisfiability validation (C2 global pass).
const HOST_ARTIFACT_EARLIEST_POINT_IDX = (() => {
  const m = Object.create(null);
  for (const entry of LOOP_HOST_CONTRACT) {
    // The :post point is the last point in each step's points array.
    const postPoint = entry.points[entry.points.length - 1];
    const postIdx = POINT_ORDER.indexOf(postPoint);
    for (const artifact of entry.coreArtifacts.produces) {
      // Only record the earliest (should be unique, but take min to be safe).
      if (m[artifact] === undefined || postIdx < m[artifact]) {
        m[artifact] = postIdx;
      }
    }
  }
  return m;
})();

// Flatten all valid loop points into a Set for O(1) validation
const VALID_LOOP_POINTS = new Set(POINT_ORDER);

// Map point → step contract (agentRoles + coreArtifacts)
const POINT_TO_CONTRACT = new Map();
for (const entry of LOOP_HOST_CONTRACT) {
  for (const point of entry.points) {
    POINT_TO_CONTRACT.set(point, entry);
  }
}

// ─── Config-slice validation ──────────────────────────────────────────────────

const VALID_CONFIG_SLICE_TYPES = new Set(['boolean', 'string', 'number', 'enum']);

/**
 * Validate a single config-slice entry (one key's { type, default, description }).
 * Returns an array of error strings. Empty = valid.
 *
 * @param {string} capId     Capability id (for error messages)
 * @param {string} key       Config key (for error messages)
 * @param {object} slice     The slice object from cap.config[key]
 * @returns {string[]}
 */
function validateConfigSliceEntry(capId, key, slice) {
  const errors = [];

  if (typeof slice !== 'object' || slice === null || Array.isArray(slice)) {
    errors.push('capability "' + capId + '" config["' + key + '"]: slice must be a non-null object');
    return errors;
  }

  // type must be one of the allowed set
  if (!VALID_CONFIG_SLICE_TYPES.has(slice.type)) {
    errors.push(
      'capability "' + capId + '" config["' + key + '"]: type must be one of ' +
      [...VALID_CONFIG_SLICE_TYPES].join(', ') + ' (got: ' + JSON.stringify(slice.type) + ')',
    );
  }

  // default must be present
  if (!Object.prototype.hasOwnProperty.call(slice, 'default')) {
    errors.push(
      'capability "' + capId + '" config["' + key + '"]: default is required',
    );
  } else {
    // type-consistency check
    const def = slice.default;
    if (slice.type === 'boolean') {
      if (typeof def !== 'boolean') {
        errors.push(
          'capability "' + capId + '" config["' + key + '"]: default must be a boolean for type:"boolean" (got: ' + typeof def + ')',
        );
      }
    } else if (slice.type === 'string') {
      if (typeof def !== 'string') {
        errors.push(
          'capability "' + capId + '" config["' + key + '"]: default must be a string for type:"string" (got: ' + typeof def + ')',
        );
      }
    } else if (slice.type === 'number') {
      if (typeof def !== 'number') {
        errors.push(
          'capability "' + capId + '" config["' + key + '"]: default must be a number for type:"number" (got: ' + typeof def + ')',
        );
      } else if (!Number.isFinite(def)) {
        // FIX 6a: Reject NaN and non-finite number defaults
        errors.push(
          'capability "' + capId + '" config["' + key + '"]: default for type:"number" must be a finite number (got: ' + String(def) + ')',
        );
      }
    } else if (slice.type === 'enum') {
      // FIX 5a: enum REQUIRES a non-empty values array (all strings), and default must be in it
      if (!Array.isArray(slice.values) || slice.values.length === 0) {
        errors.push(
          'capability "' + capId + '" config["' + key + '"]: type:"enum" requires a non-empty "values" array of strings',
        );
      } else if (!slice.values.every((v) => typeof v === 'string')) {
        errors.push(
          'capability "' + capId + '" config["' + key + '"]: type:"enum" values array must contain only strings',
        );
      }
      if (typeof def !== 'string') {
        errors.push(
          'capability "' + capId + '" config["' + key + '"]: default must be a string for type:"enum" (got: ' + typeof def + ')',
        );
      } else if (Array.isArray(slice.values) && slice.values.length > 0 && !slice.values.includes(def)) {
        errors.push(
          'capability "' + capId + '" config["' + key + '"]: default "' + def +
          '" is not one of the declared enum values [' + slice.values.join(', ') + ']',
        );
      }
    }
  }

  // description must be a non-empty string
  if (typeof slice.description !== 'string' || slice.description.length === 0) {
    errors.push(
      'capability "' + capId + '" config["' + key + '"]: description must be a non-empty string (got: ' + JSON.stringify(slice.description) + ')',
    );
  }

  return errors;
}

// ─── Per-capability validation ────────────────────────────────────────────────

const KEBAB_RE = /^[a-z][a-z0-9-]*$/;
// ADR-2782 D3: a third role for reviewer lanes that are NOT install targets
// (gemini, coderabbit, ollama, lm_studio, llama_cpp). A `role: "reviewer"`
// capability carries a reviewer body, no runtime body, and no install surface.
const VALID_ROLES = new Set(['feature', 'runtime', 'reviewer']);
const VALID_TIERS = new Set(['core', 'standard', 'full']);
const VALID_ON_ERROR = new Set(['skip', 'halt']);
const RUNTIME_COMPAT_WILDCARD = '*';

// ── ADR-1244 D1: versioned-manifest envelope ─────────────────────────────────
// Official strict SemVer 2.0.0 grammar (https://semver.org). Rejects partials
// ("1.0"), prefixes ("v1.0.0"), leading-zero segments ("01.2.3"), numeric
// prerelease identifiers with leading zeros ("1.2.3-01"), empty identifiers
// ("1.2.3-..") and — critically — prerelease/build identifiers containing
// anything outside [0-9A-Za-z-] (so a version can never smuggle shell
// metacharacters, spaces or unicode into a downstream `git tag v<version>` or
// path). Accepts "1.2.3-dev.0", "1.2.3-rc.1", "1.2.3+build.5".
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
// Permissive *shape* check for a semver range (engines.gsd / compatVersions
// values). Range SATISFACTION is enforced by the runtime overlay (ADR-1244 D2);
// here we only reject empty/garbage and shell metacharacters.
const SEMVER_RANGE_RE = /^[0-9A-Za-z.\-+ |<>=~^*()]+$/;
// Subresource-integrity hash: "sha512-" + base64 of a 64-byte digest (86 base64
// chars + "==" padding). Exact length so malformed pins ("sha512-abc") fail.
const SHA512_INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]{86}==$/;

// #1460 (R) HIGH — shell-safe hook-script allowlist. A hook `script` is resolved to an
// ABSOLUTE path and written verbatim as the hook `command` STRING in settings.json, which a
// host runtime consumes through a shell (first-party hooks emit `node "${...}/hooks/x.js"`).
// A manifest-controlled name like `run.sh; touch /tmp/pwn` (filenames may legally contain
// `;`, spaces, `$`, backtick, `|`, newline on POSIX) would inject a second command — even
// though the file genuinely exists inside the bundle and so passes path-confinement. We
// therefore restrict the relative script path to a CONSERVATIVE allowlist: only
// [A-Za-z0-9._/-], with no leading `-` on any segment (option-injection), no `..` segment,
// and not absolute. Anything else (whitespace, any shell metacharacter, control/NUL) is a
// hard validation error — fail closed so the capability install/load is rejected loudly.
const SAFE_HOOK_SCRIPT_RE = /^[A-Za-z0-9._/-]+$/;

/**
 * #1460 (R): true when a relative hook-script path is shell-safe (see SAFE_HOOK_SCRIPT_RE).
 * Rejects absolute paths, `..` segments, a leading `-` on any path segment, and any char
 * outside the allowlist (whitespace / shell metacharacters / control / NUL).
 */
function isSafeHookScriptPath(script) {
  if (typeof script !== 'string' || script.length === 0) return false;
  if (!SAFE_HOOK_SCRIPT_RE.test(script)) return false;
  if (path.isAbsolute(script)) return false;
  const segments = script.split(/[/\\]/);
  if (segments.includes('..')) return false;
  // A leading '-' on any segment would be parsed as an option by the shell/`node`.
  for (const seg of segments) {
    if (seg.startsWith('-')) return false;
  }
  return true;
}

// A syntactically plausible semver range (shape-only — see SEMVER_RANGE_RE).
// Requires a digit or a bare wildcard so pure-alpha garbage ("abcx", "()x") is
// rejected; full range satisfaction is the runtime overlay's job (ADR-1244 D2).
function isPlausibleRange(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (t.length === 0 || !SEMVER_RANGE_RE.test(s)) return false;
  return /\d/.test(t) || t === '*' || t === 'x' || t === 'X';
}

/**
 * ADR-1244 D1: validate the versioned-manifest envelope.
 *   - version        REQUIRED semver string (the registry rejects a manifest
 *                    without one).
 *   - engines        optional object; engines.gsd optional semver-range string.
 *   - compatVersions optional object mapping a capability version (semver) to a
 *                    gsd version range.
 *   - integrity      optional "sha512-<base64>" string.
 *   - provenance     optional { sourceRepo, commit } strings.
 *
 * Shape only — range satisfaction and integrity verification are enforced by
 * the source resolver / runtime overlay (ADR-1244 D2/D3).
 *
 * @param {object} cap   The parsed JSON object.
 * @returns {string[]}   Array of error strings; empty = valid.
 */
function validateVersionEnvelope(cap) {
  const errors = [];

  if (typeof cap.version !== 'string' || !SEMVER_RE.test(cap.version)) {
    errors.push('version must be a semver string (e.g. "1.2.3"); got: ' + JSON.stringify(cap.version));
  }

  if (cap.engines !== undefined) {
    if (typeof cap.engines !== 'object' || cap.engines === null || Array.isArray(cap.engines)) {
      errors.push('engines must be an object (e.g. { "gsd": ">=1.6.0" })');
    } else if (cap.engines.gsd !== undefined && !isPlausibleRange(cap.engines.gsd)) {
      errors.push('engines.gsd must be a semver range string; got: ' + JSON.stringify(cap.engines.gsd));
    }
  }

  if (cap.compatVersions !== undefined) {
    if (typeof cap.compatVersions !== 'object' || cap.compatVersions === null || Array.isArray(cap.compatVersions)) {
      errors.push('compatVersions must be an object mapping capability versions to gsd version ranges');
    } else {
      for (const [k, v] of Object.entries(cap.compatVersions)) {
        if (!SEMVER_RE.test(k)) errors.push('compatVersions key "' + k + '" must be a semver string');
        if (!isPlausibleRange(v)) errors.push('compatVersions["' + k + '"] must be a semver range string');
      }
    }
  }

  if (cap.integrity !== undefined && (typeof cap.integrity !== 'string' || !SHA512_INTEGRITY_RE.test(cap.integrity))) {
    errors.push('integrity must be a "sha512-<base64>" string');
  }

  if (cap.provenance !== undefined) {
    const p = cap.provenance;
    if (typeof p !== 'object' || p === null || Array.isArray(p)) {
      errors.push('provenance must be an object { sourceRepo, commit }');
    } else {
      if (typeof p.sourceRepo !== 'string' || p.sourceRepo.length === 0) {
        errors.push('provenance.sourceRepo must be a non-empty string');
      }
      if (typeof p.commit !== 'string' || p.commit.length === 0) {
        errors.push('provenance.commit must be a non-empty string');
      }
    }
  }

  return errors;
}

/**
 * Validate a single capability declaration.
 *
 * @param {object} cap        The parsed JSON object.
 * @param {string} folderId   The folder name (must equal cap.id).
 * @returns {string[]}        Array of error strings; empty = valid.
 */
function validateCapability(cap, folderId) {
  const errors = [];

  if (typeof cap !== 'object' || cap === null || Array.isArray(cap)) {
    return ['capability must be a JSON object'];
  }

  // ── Common envelope ────────────────────────────────────────────────────────

  if (typeof cap.id !== 'string' || !KEBAB_RE.test(cap.id)) {
    errors.push('id must be a kebab-case string');
  } else if (cap.id !== folderId) {
    errors.push('id "' + cap.id + '" must equal the folder name "' + folderId + '"');
  }

  if (!VALID_ROLES.has(cap.role)) {
    errors.push('role must be one of: ' + [...VALID_ROLES].join(', ') + ' (got: ' + cap.role + ')');
  }

  if (typeof cap.title !== 'string' || cap.title.length === 0) {
    errors.push('title must be a non-empty string');
  }

  // C4: description is required
  if (typeof cap.description !== 'string' || cap.description.length === 0) {
    errors.push('description must be a non-empty string');
  }

  if (!VALID_TIERS.has(cap.tier)) {
    errors.push('tier must be one of: core, standard, full (got: ' + cap.tier + ')');
  }

  if (!Array.isArray(cap.requires)) {
    errors.push('requires must be an array of capability ids');
  } else {
    for (const req of cap.requires) {
      if (typeof req !== 'string') {
        errors.push('requires entries must be strings (got: ' + JSON.stringify(req) + ')');
      }
    }
  }

  // ── Versioned-manifest envelope (ADR-1244 D1) ──────────────────────────────
  errors.push(...validateVersionEnvelope(cap));

  // ── Role-specific body ────────────────────────────────────────────────────

  if (cap.role === 'feature') {
    errors.push(...validateFeatureBody(cap));
    // ADR-2782 D1 admits the reviewer body on `runtime` and `reviewer` ONLY. A
    // feature capability owns loop artefacts, not an external review CLI. This is
    // an ERROR rather than an ignored field because declaring a body is an
    // ASSERTION of lane-ness (D4's Postel boundary), and a manifest built for a
    // GSD that admits it declares `engines.gsd` and is gated before reaching here.
    if (cap.reviewer !== undefined) {
      errors.push('role:feature capability must not have a "reviewer" body (admissible on role runtime or reviewer only)');
    }
  } else if (cap.role === 'runtime') {
    errors.push(...validateRuntimeBody(cap));
    // A host that is ALSO a reviewer keeps exactly one manifest (ADR-2782 D1).
    errors.push(...validateReviewerBody(cap));
  } else if (cap.role === 'reviewer') {
    // ADR-2782 D3 — a lane that is not an install target. No runtime body, no
    // install surface, no runtimeCompat (it surfaces through no host runtime).
    if (cap.reviewer === undefined) {
      errors.push('role:reviewer capability must have a "reviewer" body — the role asserts a lane');
    }
    if (cap.runtime !== undefined) {
      errors.push('role:reviewer capability must not have a "runtime" body (it is not an install target)');
    }
    for (const field of FEATURE_FIELDS_FORBIDDEN_ON_REVIEWER) {
      if (cap[field] !== undefined) {
        errors.push('role:reviewer capability must not have "' + field + '" (feature-only field)');
      }
    }
    errors.push(...validateReviewerBody(cap));
  }

  return errors;
}

/**
 * ADR-959: Validate a single commands[] entry on a feature-role capability.
 * { family: string, module: string, router: string, subcommands?: string[] }
 *
 * - family: non-empty string, no reserved names
 * - module: non-empty string, no path traversal, no absolute paths, no "/"
 *   segments other than a bare basename (expected form: "foo.cjs")
 * - router: non-empty string
 * - subcommands: optional array of strings (doc/introspection only)
 *
 * @param {string} capId     Capability id (for error messages)
 * @param {*}      entry     The entry to validate
 * @param {string} prefix    Path prefix (e.g. "commands[0]")
 * @returns {string[]}       Array of error strings; empty = valid.
 */
function validateCommandEntry(capId, entry, prefix) {
  const errors = [];
  const ctx = 'capability "' + capId + '" ' + prefix;

  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    errors.push(ctx + ' must be an object with family, module, and router');
    return errors;
  }

  // family: non-empty string, no reserved names
  if (typeof entry.family !== 'string' || entry.family.length === 0) {
    errors.push(ctx + '.family must be a non-empty string');
  } else if (entry.family === '__proto__' || entry.family === 'constructor' || entry.family === 'prototype') {
    // S2a: inline literal reserved-name guard (CodeQL barrier)
    errors.push(ctx + '.family "' + entry.family + '" is a reserved name');
  }

  // module: must be a safe bare basename matching /^[A-Za-z0-9._-]+\.cjs$/ —
  // no path separators, no "..", no NUL bytes, no absolute paths, ends in .cjs.
  // This conservative pattern subsumes all earlier traversal/absolute/separator checks.
  if (typeof entry.module !== 'string' || entry.module.length === 0) {
    errors.push(ctx + '.module must be a non-empty string');
  } else {
    const mod = entry.module;
    const SAFE_BASENAME = /^[A-Za-z0-9._-]+\.cjs$/;
    if (!SAFE_BASENAME.test(mod)) {
      errors.push(
        ctx + '.module must be a safe bare basename (pattern: /^[A-Za-z0-9._-]+\\.cjs$/, no path separators, no "..", no NUL bytes, must end in ".cjs"); got: ' +
        JSON.stringify(mod),
      );
    }
  }

  // router: non-empty string
  if (typeof entry.router !== 'string' || entry.router.length === 0) {
    errors.push(ctx + '.router must be a non-empty string');
  }

  // subcommands: optional array of non-empty strings (doc/introspection only)
  if (entry.subcommands !== undefined) {
    if (!Array.isArray(entry.subcommands)) {
      errors.push(ctx + '.subcommands must be an array of strings if present');
    } else {
      for (let i = 0; i < entry.subcommands.length; i++) {
        if (typeof entry.subcommands[i] !== 'string') {
          errors.push(ctx + '.subcommands[' + i + '] must be a string');
        } else if (entry.subcommands[i].length === 0) {
          errors.push(ctx + '.subcommands[' + i + '] must be a non-empty string');
        }
      }
    }
  }

  return errors;
}

function validateRuntimeCompat(capId, runtimeCompat) {
  const errors = [];
  const ctx = 'capability "' + capId + '" runtimeCompat';

  if (typeof runtimeCompat !== 'object' || runtimeCompat === null || Array.isArray(runtimeCompat)) {
    errors.push(ctx + ' must be an object with supported and unsupported arrays');
    return errors;
  }

  const validateRuntimeArray = (field, { allowWildcard }) => {
    const value = runtimeCompat[field];
    if (!Array.isArray(value)) {
      errors.push(ctx + '.' + field + ' must be an array of runtime ids' + (allowWildcard ? ' or ["*"]' : ''));
      return;
    }
    if (field === 'supported' && value.length === 0) {
      errors.push(ctx + '.supported must be a non-empty array');
    }
    let hasWildcard = false;
    for (let i = 0; i < value.length; i++) {
      const entry = value[i];
      if (typeof entry !== 'string' || entry.length === 0) {
        errors.push(ctx + '.' + field + '[' + i + '] must be a non-empty string');
        continue;
      }
      if (entry === '__proto__' || entry === 'constructor' || entry === 'prototype') {
        errors.push(ctx + '.' + field + '[' + i + '] "' + entry + '" is a reserved name');
      }
      if (entry === RUNTIME_COMPAT_WILDCARD) {
        if (!allowWildcard) {
          errors.push(ctx + '.' + field + ' must not include wildcard "*"');
        }
        hasWildcard = true;
      } else if (!KEBAB_RE.test(entry)) {
        errors.push(ctx + '.' + field + '[' + i + '] must be a kebab-case runtime id or "*"');
      }
    }
    if (hasWildcard && value.length > 1) {
      errors.push(ctx + '.' + field + ' wildcard "*" cannot be mixed with runtime ids');
    }
  };

  validateRuntimeArray('supported', { allowWildcard: true });
  validateRuntimeArray('unsupported', { allowWildcard: false });

  if (runtimeCompat.notes !== undefined) {
    if (typeof runtimeCompat.notes !== 'object' || runtimeCompat.notes === null || Array.isArray(runtimeCompat.notes)) {
      errors.push(ctx + '.notes must be an object of runtime id to string if present');
    } else {
      for (const [key, value] of Object.entries(runtimeCompat.notes)) {
        if (key !== RUNTIME_COMPAT_WILDCARD && !KEBAB_RE.test(key)) {
          errors.push(ctx + '.notes key "' + key + '" must be a kebab-case runtime id or "*"');
        }
        if (typeof value !== 'string' || value.length === 0) {
          errors.push(ctx + '.notes["' + key + '"] must be a non-empty string');
        }
      }
    }
  }

  return errors;
}

function validateFeatureBody(cap) {
  const errors = [];

  errors.push(...validateRuntimeCompat(cap.id || '(unknown)', cap.runtimeCompat));

  if (!Array.isArray(cap.skills)) {
    errors.push('skills must be an array of strings');
  } else {
    for (const s of cap.skills) {
      if (typeof s !== 'string') {
        errors.push('skills entries must be strings');
      } else if (s === '__proto__' || s === 'constructor' || s === 'prototype') {
        // S2a: inline literal reserved-name guard (CodeQL barrier)
        errors.push('skills entry "' + s + '" is a reserved name');
      }
    }
  }

  // ADR-959: optional commands array
  if (cap.commands !== undefined) {
    if (!Array.isArray(cap.commands)) {
      errors.push('commands must be an array of {family, module, router} objects');
    } else {
      for (let i = 0; i < cap.commands.length; i++) {
        errors.push(...validateCommandEntry(cap.id || cap.role, cap.commands[i], 'commands[' + i + ']'));
      }
    }
  }

  if (!Array.isArray(cap.agents)) {
    errors.push('agents must be an array of strings');
  } else {
    for (const a of cap.agents) {
      if (typeof a !== 'string') {
        errors.push('agents entries must be strings');
      } else if (a === '__proto__' || a === 'constructor' || a === 'prototype') {
        // S2a: inline literal reserved-name guard (CodeQL barrier)
        errors.push('agents entry "' + a + '" is a reserved name');
      }
    }
  }

  if (typeof cap.config !== 'object' || cap.config === null || Array.isArray(cap.config)) {
    errors.push('config must be an object');
  } else {
    // C5: validate config key names and value shapes
    for (const key of Object.keys(cap.config)) {
      if (key === '' ) {
        errors.push('config keys must be non-empty strings');
      } else if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        // S2a: inline literal reserved-name guard (CodeQL barrier)
        errors.push('config key "' + key + '" is a reserved name');
      }
      const val = cap.config[key];
      if (val === null || typeof val !== 'object' || Array.isArray(val)) {
        errors.push('config["' + key + '"] must be an object (got: ' + (val === null ? 'null' : typeof val) + ')');
      } else if (typeof val.type !== 'string' || val.type.length === 0) {
        errors.push('config["' + key + '"] must have a string "type" field (e.g. "boolean", "string", "number", "enum")');
      }
    }
  }

  // C4: hooks, when present, must be an array of {event: string, script: string}
  if (cap.hooks !== undefined) {
    if (!Array.isArray(cap.hooks)) {
      errors.push('hooks must be an array of {event, script} objects');
    } else {
      for (let i = 0; i < cap.hooks.length; i++) {
        const h = cap.hooks[i];
        if (typeof h !== 'object' || h === null || Array.isArray(h)) {
          errors.push('hooks[' + i + '] must be an object with event and script keys');
        } else {
          if (typeof h.event !== 'string' || h.event.length === 0) {
            errors.push('hooks[' + i + '].event must be a non-empty string');
          }
          if (typeof h.script !== 'string' || h.script.length === 0) {
            errors.push('hooks[' + i + '].script must be a non-empty string');
          } else if (!isSafeHookScriptPath(h.script)) {
            // #1460 (R) HIGH: the script becomes an absolute hook `command` consumed by a shell;
            // reject any unsafe character (shell metacharacters/whitespace/control), a leading `-`,
            // an absolute path, or a `..` segment so a manifest can never inject a second command.
            errors.push(
              'hooks[' + i + '].script must be a relative path containing only [A-Za-z0-9._/-] ' +
              '(no whitespace, shell metacharacters (e.g. ; | & $ ` ( ) < > * ? newline), leading "-", ' +
              'absolute path, or ".." segment) — it contains unsafe characters: ' + JSON.stringify(h.script),
            );
          }
          // #1634: optional tool-scoping `matcher` (a settings.json concept — exact tool name,
          // pipe-separated list, wildcard, or regex; e.g. "Write|Edit"). When present it must be a
          // non-empty string without control characters; absent => match-all (omitted at projection
          // so existing shipped capabilities are unchanged).
          if (h.matcher !== undefined) {
            if (typeof h.matcher !== 'string' || h.matcher.length === 0) {
              errors.push('hooks[' + i + '].matcher must be a non-empty string when present');
            } else {
              // Reject ASCII control characters (0x00-0x1f and 0x7f DEL) via char codes — a literal
              // control-char range regex trips ESLint's no-control-regex rule, and char codes are
              // equally precise.
              let hasControl = false;
              for (let c = 0; c < h.matcher.length; c++) {
                const code = h.matcher.charCodeAt(c);
                if (code < 0x20 || code === 0x7f) { hasControl = true; break; }
              }
              if (hasControl) {
                errors.push('hooks[' + i + '].matcher must not contain control characters');
              }
            }
          }
        }
      }
    }
  }

  // Build the declared skill/agent sets for ref membership checks (used in validateStep).
  // Only build these if the arrays are valid (already validated above).
  const declaredSkills = Array.isArray(cap.skills) ? new Set(cap.skills.filter((s) => typeof s === 'string')) : null;
  const declaredAgents = Array.isArray(cap.agents) ? new Set(cap.agents.filter((a) => typeof a === 'string')) : null;

  if (!Array.isArray(cap.steps)) {
    errors.push('steps must be an array');
  } else {
    for (let i = 0; i < cap.steps.length; i++) {
      errors.push(...validateStep(cap.steps[i], 'steps[' + i + ']', declaredSkills, declaredAgents));
    }
  }

  if (!Array.isArray(cap.contributions)) {
    errors.push('contributions must be an array');
  } else {
    for (let i = 0; i < cap.contributions.length; i++) {
      errors.push(...validateContribution(cap.contributions[i], 'contributions[' + i + ']'));
    }
  }

  if (!Array.isArray(cap.gates)) {
    errors.push('gates must be an array');
  } else {
    for (let i = 0; i < cap.gates.length; i++) {
      errors.push(...validateGate(cap.gates[i], 'gates[' + i + ']'));
    }
  }

  // activationKey: optional string naming the dotted config key that gates this capability.
  // If present: must be a non-empty string that is declared in this capability's own config slice.
  if (cap.activationKey !== undefined) {
    if (typeof cap.activationKey !== 'string' || cap.activationKey.length === 0) {
      errors.push(
        'capability "' + (cap.id || '(unknown)') + '" activationKey must be a non-empty string (got: ' +
        JSON.stringify(cap.activationKey) + ')',
      );
    } else if (cap.activationKey === '__proto__' || cap.activationKey === 'constructor' || cap.activationKey === 'prototype') {
      // Prototype-pollution guard (inline literal, CodeQL barrier)
      errors.push(
        'capability "' + (cap.id || '(unknown)') + '" activationKey "' + cap.activationKey +
        '" is a reserved JavaScript property name and cannot be used as an activationKey',
      );
    } else if (
      typeof cap.config !== 'object' ||
      cap.config === null ||
      !Object.prototype.hasOwnProperty.call(cap.config, cap.activationKey)
    ) {
      errors.push(
        'capability "' + (cap.id || '(unknown)') + '" activationKey "' + cap.activationKey +
        '" is not declared in this capability\'s config slice — add it to the "config" object or use a key that is declared there',
      );
    }
  }

  return errors;
}

// ADR-857 phase 5e: Closed ConverterName enum — complete set used across 16 runtime descriptors,
// all exported by bin/install.js (commands/skills) and src/runtime-artifact-conversion.cts (agents).
// Any ArtifactKind with a non-null converter must use one of these.
const VALID_CONVERTER_NAMES = new Set([
  // commands / skills converters (pre-existing)
  'convertClaudeCommandToAntigravitySkill',
  'convertClaudeCommandToAugmentSkill',
  'convertClaudeCommandToClineSkill',
  'convertClaudeCommandToClaudeSkill',
  'convertClaudeCommandToCodebuddyCommand',
  'convertClaudeCommandToCodebuddySkill',
  'convertClaudeCommandToCodexSkill',
  'convertClaudeCommandToCopilotSkill',
  'convertClaudeCommandToCursorCommand',
  'convertClaudeCommandToCursorSkill',
  'convertClaudeCommandToKiloSkill',
  'convertClaudeCommandToKimiSkill',
  'convertClaudeCommandToKimiCodeSkill',
  'convertClaudeCommandToOpencodeSkill',
  'convertClaudeCommandToTraeSkill',
  'convertClaudeCommandToWindsurfSkill',
  'convertClaudeCommandToWindsurfWorkflow',
  // agent converters (#1173 — descriptor-driven agent conversion wiring)
  'convertClaudeAgentToCopilotAgent',
  'convertClaudeAgentToAntigravityAgent',
  'convertClaudeAgentToCursorAgent',
  'convertClaudeAgentToWindsurfAgent',
  'convertClaudeAgentToAugmentAgent',
  'convertClaudeAgentToTraeAgent',
  'convertClaudeAgentToCodebuddyAgent',
  'convertClaudeAgentToClineAgent',
  'convertClaudeAgentToCodexAgent',
  // ADR-1239 / #2092 Phase B Upgrade 1 — native .qwen/agents/*.md subagent projection.
  'convertClaudeAgentToQwenAgent',
]);

// C3: Validate role:runtime body
const VALID_CONFIG_FORMATS = new Set(['settings-json', 'toml', 'markdown', 'markdown-dir', 'none']);
// 'none' added #2103 — Marketplace/VSIX-distributed hosts (e.g. VS Code) with
// no file-projected config directory at all.
const VALID_CONFIG_HOME_KINDS = new Set(['dot-home', 'dot-home-nested', 'xdg', 'generic-agents-root', 'none']);
const VALID_COMMAND_STYLES = new Set(['slash-hyphen', 'shell-var']);
const VALID_HOOKS_SURFACES = new Set(['settings-json', 'codex-hooks-json', 'cursor-hooks-json', 'copilot-inline', 'cline-rules', 'kimi-hooks-toml', 'windsurf-hooks-json', 'none']);
const VALID_HOOK_EVENTS = new Set(['claude', 'gemini']);
// extensionEvents — the plugin/extension-system event dialect (ADR-1239 amendment / #1943).
// DISTINCT from hookEvents (managed-hook dialect): extensionEvents describes the
// plugin-owned event subset imperative hosts expose (opencode / pi); 'none' = the
// host exposes no extension surface (engine owns the bus, e.g. VS Code).
const VALID_EXTENSION_EVENTS = new Set(['opencode', 'pi', 'hermes', 'kilo', 'none']);
const VALID_SANDBOX_TIERS = new Set(['none', 'codex-agent-sandbox']);
const VALID_ARTIFACT_KIND_NAMES = new Set(['commands', 'agents', 'skills', 'kimi-agents']);
const VALID_ARTIFACT_NESTINGS = new Set(['flat', 'nested']);
const FEATURE_FIELDS_FORBIDDEN_ON_RUNTIME = ['skills', 'agents', 'steps', 'contributions', 'gates', 'hooks', 'activationKey'];
// 'none' added #2103 — Marketplace/VSIX-distributed hosts (e.g. VS Code) that
// are never CLI-installed (no allRuntimes membership, no install flag).
const VALID_INSTALL_SURFACES = new Set(['settings-json', 'codex-toml', 'copilot-instructions', 'cline-rules', 'cursor-hooks-json', 'profile-marker-only', 'none']);
// 'antigravity' added #2096 Phase B Upgrade 1 — settings.json permissions.allow writer.
const VALID_PERMISSION_WRITERS = new Set(['opencode', 'kilo', 'antigravity']);
// SubagentStart added #2092 Phase B Upgrade 2 (qwen-only today — see
// capabilities/qwen/capability.json's extendedHookEvents).
const VALID_EXTENDED_HOOK_EVENTS = new Set(['SubagentStop', 'Stop', 'PreCompact', 'FileChanged', 'BeforeAgent', 'AfterAgent', 'BeforeModel', 'SubagentStart']);

// ADR-1239 Phase A: hostIntegration axes (MUST stay parity-identical to HOST_INTEGRATION_AXES in src/host-integration.cts)
const VALID_EMBEDDING_MODES   = new Set(['imperative', 'declarative']);
const VALID_COMMAND_SURFACES  = new Set(['slash-file', 'slash-programmatic', 'slash-toml', 'palette', 'prose-only']);
const VALID_MODEL_MODES       = new Set(['active', 'passive']);
const VALID_HOOK_BUSES        = new Set(['host', 'engine', 'none']);
const VALID_STATE_IO          = new Set(['filesystem', 'sandboxed-storage', 'session-log-append']);
const VALID_TRANSPORTS        = new Set(['mcp', 'native-extension']);
const VALID_HOST_RUNTIMES     = new Set(['node', 'bun', 'sandboxed-web', 'python', 'go', 'rust', 'electron', 'other']);
const VALID_SUBAGENT_TOOLKITS = new Set(['full', 'read-only', 'built-in-only']);
// ADR-1239 amendment (#2481): how reasoning effort reaches the host.
const VALID_EFFORT_SURFACES   = new Set(['argv', 'none']);
// ADR-1239 Codex-binding amendment (#2584): how a host isolates concurrent
// same-wave executors — a dispatch sub-field, not a top-level axis.
const VALID_DISPATCH_ISOLATION = new Set(['harness-worktree', 'orchestrator-worktree', 'none']);

// ─── Reviewer lane body (ADR-2782 D1/D2/D3/D7/D8) ────────────────────────────
//
// A reviewer lane is one external CLI or model endpoint that /gsd:review hands a
// plan to. The body is admissible on `role: "runtime"` (a host that is ALSO a
// reviewer) and on `role: "reviewer"` (a lane that is not an install target).
//
// The vocabulary below tracks src/review-lane-descriptor.cts (Phase 1, #2794)
// field-for-field INCLUDING nesting, so no translation layer exists between the
// core descriptor and the manifest. Four members were added by Phase 1's ADR
// amendment, each forced by a lane that ships today: `promptChannel: 'none'`
// (CodeRabbit is fed no prompt), `outputChannel: 'file-arg'` + `outputArg`
// (Codex writes via -o and discards stdout, #1698), and `flags[]` (Antigravity
// answers to both --antigravity and --agy).
//
// EVERY error message below enumerates its valid members. That is deliberate:
// the prose reference lands in Phase 6 (#2800), so until then the validator's
// own errors ARE the documentation — the same gap that left `hostBehaviors`
// discoverable only by grepping a source line is not repeated here.

// A slug is NOT a capability id. Ids are kebab (KEBAB_RE, which rejects "_");
// slugs carry the shipped roster's snake forms (`lm_studio`, `llama_cpp`) and
// name the config keys (`review.lm_studio_host`) that ADR-2782 D9 leaves
// unchanged. Reusing KEBAB_RE here would reject two shipped lanes.
//
// ⚠ DEFECT.GENERATIVE-FIX — this grammar is DUPLICATED, by necessity, from
// `LANE_SLUG_RE` in src/review-lane-descriptor.cts (Phase 1, #2794). It cannot be
// imported: that module compiles to gsd-core/bin/lib/review-lane-descriptor.cjs,
// which is gitignored build output, and THIS file is a committed plain .cjs that
// must load on a fresh worktree before `npm run build:lib` has ever run (see the
// header). Two surfaces sharing one parser therefore require a parity assertion
// that fails when they diverge — `laneSlugGrammarMatchesPhase1Descriptor` in
// tests/reviewer-manifest-body.test.cjs.
//
// A LEADING DIGIT IS PERMITTED. Phase 1 allows it and a manifest validator that
// did not would reject a slug the core descriptor accepts — a model-named lane
// such as `4o-mini` — which is exactly the translation layer ADR-2782 exists to
// delete. Keep the two grammars byte-identical.
const LANE_SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
// Flags are kebab even when the slug is snake: `lm_studio` → `--lm-studio`.
// Phase 1 declares flags but does not constrain their grammar, so this is the
// first and only definition — no parity partner to track.
const LANE_FLAG_RE = /^--[a-z0-9][a-z0-9-]*$/;

const VALID_LANE_TRANSPORTS   = new Set(['spawn', 'openai-http']);
const VALID_LANE_PROBE_KINDS  = new Set(['command-exists', 'command-capability', 'http-reachable']);
const VALID_PROMPT_CHANNELS   = new Set(['stdin', 'argv', 'argv-file-ref', 'none']);
const VALID_OUTPUT_CHANNELS   = new Set(['stdout', 'file-arg']);
const VALID_LANE_EFFORT_CHANNELS = new Set(['none', 'argv', 'env']);
const VALID_MODEL_DISCOVERY   = new Set(['none', 'first-from-models-endpoint']);
const VALID_EMPTY_OUTPUT      = new Set(['stub-with-stderr', 'handler-owned']);
const VALID_EVIDENCE_CLASSES  = new Set(['source-grounded', 'diff-only']);

// ADR-2782 D6 — a CLOSED enum of FIRST-PARTY module names, never a path and
// never third-party code. `null` is the default and covers 7 of the 11 shipped
// lanes; it is checked separately because a Set cannot hold the "declared
// absent" case distinctly from an unknown string.
//
// ADMISSION RULE for a new member — this enum is the pressure valve that keeps
// the descriptor from becoming an ad-hoc interpreter, and it only works while
// membership stays scarce. A new member requires EITHER >=2 lanes that share the
// behaviour, OR a documented upstream defect that data provably cannot express.
// Today: `openai-compatible` serves 3 lanes (healthy); `antigravity` serves 1,
// justified solely by a documented upstream stdout bug. An enum that grows one
// member per lane has stopped being a vocabulary and become a dispatch table for
// bespoke code — at which point the descriptor is a plugin system wearing a
// manifest, and that is a decision for an ADR, not for a downstream phase.
// `opencode` admitted by Phase 5b (#2799) under the SECOND arm of the rule above:
// it serves 1 lane, justified by a documented upstream defect data cannot express.
// OpenCode's default `build` agent is an agentic coder, not a prompt→completion
// API; on a large review prompt it can end its turn with ZERO output tokens, and
// `--format default` then drops the assistant text entirely, silently losing the
// reviewer (#1936). The review must therefore be RECONSTRUCTED from the assistant
// `text` parts of a `--format json` stream — a parse, not a copy. Expressing that
// as data would need an `outputChannel: 'json-parts'` plus a selector expression,
// i.e. exactly the ad-hoc interpreter the admission rule exists to prevent.
const VALID_LANE_HANDLERS     = new Set(['antigravity', 'openai-compatible', 'opencode']);

// D2 — `transport` selects the invoke sub-shape. A manifest carrying fields from
// BOTH sub-shapes, or from NEITHER, has undefined meaning and fails validation.
// The discriminator is explicit rather than inferred from field presence, which
// is precisely the ambiguity these two sets exist to detect.
const SPAWN_ONLY_INVOKE_FIELDS = ['binary', 'args', 'promptChannel', 'outputChannel', 'outputArg', 'modelArg'];
// `defaultHost` / `fallbackModel` added by Phase 5b (#2799). Phase 4 federated every
// `review.*_host` key with a default of `""`, so the REAL fallback destination and model
// (`http://localhost:11434` / `llama3` and friends) existed only inside the bash leg. Once the
// lane is invoked from data, an unset host with no declared default would POST to a garbage URL.
const HTTP_ONLY_INVOKE_FIELDS  = ['hostConfigKey', 'defaultHost', 'path', 'modelDiscovery', 'fallbackModel'];

// Feature-only fields are as forbidden on a lane-only capability as on a runtime
// one; a `role: "reviewer"` capability owns no artefacts and wires no loop point.
const FEATURE_FIELDS_FORBIDDEN_ON_REVIEWER = ['skills', 'agents', 'steps', 'contributions', 'gates', 'hooks', 'activationKey'];

// GATE A: installSurface → allowed hooksSurface values (DEFECT.GENERATIVE-FIX: parity invariant)
// Derived from the actual pairings in the 16 real runtime descriptors.
const INSTALL_SURFACE_TO_ALLOWED_HOOKS_SURFACES = new Map([
  ['settings-json',        new Set(['settings-json', 'none'])],
  ['codex-toml',           new Set(['codex-hooks-json'])],
  ['copilot-instructions', new Set(['copilot-inline'])],
  ['cline-rules',          new Set(['cline-rules'])],
  ['cursor-hooks-json',    new Set(['cursor-hooks-json'])],
  ['profile-marker-only',  new Set(['none', 'kimi-hooks-toml', 'windsurf-hooks-json'])],
  // 'none' added #2103 — VS Code has no CLI install surface at all; its only
  // valid hooksSurface pairing is the other 'none' (engine owns the hook bus).
  ['none',                 new Set(['none'])],
]);

// GATE B: extended hook event families → required hookEvents value
// Gemini agent-events require hookEvents='gemini'; Claude-family events require hookEvents='claude'.
const GEMINI_AGENT_EVENTS = new Set(['BeforeAgent', 'AfterAgent', 'BeforeModel']);
// SubagentStart added #2092 Phase B Upgrade 2 — Claude hook-event dialect
// counterpart of SubagentStop (qwen-only today).
const CLAUDE_FAMILY_EVENTS = new Set(['SubagentStop', 'Stop', 'PreCompact', 'FileChanged', 'SubagentStart']);

/**
 * Validate a runtime.configHome object per ADR-1016 Decision 1.
 * Returns an array of error strings.
 *
 * @param {string} capId  Capability id (for error messages)
 * @param {*}      ch     The configHome value
 * @returns {string[]}
 */
function validateConfigHome(capId, ch) {
  const errors = [];
  const ctx = 'capability "' + capId + '" runtime.configHome';

  if (typeof ch !== 'object' || ch === null || Array.isArray(ch)) {
    errors.push(ctx + ' must be an object (got: ' + (ch === null ? 'null' : typeof ch) + ')');
    return errors;
  }

  // kind — must be in closed vocab; inline literal guard (CodeQL barrier)
  if (ch.kind === '__proto__' || ch.kind === 'constructor' || ch.kind === 'prototype') {
    errors.push(ctx + '.kind "' + ch.kind + '" is a reserved name');
  } else if (!VALID_CONFIG_HOME_KINDS.has(ch.kind)) {
    errors.push(
      ctx + '.kind must be one of: ' + [...VALID_CONFIG_HOME_KINDS].join(', ') +
      ' (got: ' + JSON.stringify(ch.kind) + ')',
    );
  }

  // name — required string, except when kind === 'none': the runtime has no
  // file-projected config directory at all, so a descriptive name is
  // optional (a carve-out mirroring the dot-home-nested⇒parent conditional
  // below, not a new validation mechanism). If present it must still be a
  // non-empty string (e.g. vscode's configHome.name stays a descriptive
  // "vscode" string even though it is never used to build a path).
  if (ch.kind !== 'none') {
    if (typeof ch.name !== 'string' || ch.name.length === 0) {
      errors.push(ctx + '.name must be a non-empty string');
    }
  } else if (ch.name !== undefined && (typeof ch.name !== 'string' || ch.name.length === 0)) {
    errors.push(ctx + '.name must be a non-empty string if present when kind is "none"');
  }

  // parent — required when kind == dot-home-nested
  if (ch.kind === 'dot-home-nested') {
    if (typeof ch.parent !== 'string' || ch.parent.length === 0) {
      errors.push(ctx + '.parent must be a non-empty string when kind is "dot-home-nested"');
    }
  }

  // env — required; must be an array of strings (every runtime has ≥0 env overrides)
  if (!Array.isArray(ch.env)) {
    errors.push(ctx + '.env is required and must be an array of strings (got: ' + JSON.stringify(ch.env) + ')');
  } else {
    for (let i = 0; i < ch.env.length; i++) {
      if (typeof ch.env[i] !== 'string') {
        errors.push(ctx + '.env[' + i + '] must be a string');
      }
    }
  }

  // probe — optional; if present must be an array of strings
  if (ch.probe !== undefined) {
    if (!Array.isArray(ch.probe)) {
      errors.push(ctx + '.probe must be an array of strings if present');
    } else {
      for (let i = 0; i < ch.probe.length; i++) {
        if (typeof ch.probe[i] !== 'string') {
          errors.push(ctx + '.probe[' + i + '] must be a string');
        }
      }
    }
  }

  // probeExists — optional; if present must be a non-empty string (sub-path existence check for probe)
  if (ch.probeExists !== undefined) {
    if (typeof ch.probeExists !== 'string' || ch.probeExists.length === 0) {
      errors.push(ctx + '.probeExists must be a non-empty string if present (got: ' + JSON.stringify(ch.probeExists) + ')');
    }
  }

  // skillsHome — optional; if present must be a full valid configHome object (recursive validation)
  if (ch.skillsHome !== undefined) {
    // Recursive call: validate skillsHome as a nested configHome.
    // Use a synthetic capId to surface the sub-path in error messages.
    const skillsHomeErrors = validateConfigHome(capId + '.skillsHome', ch.skillsHome);
    // Rewrite the inner ctx prefix so errors read as "...runtime.configHome.skillsHome..."
    for (const e of skillsHomeErrors) {
      errors.push(e.replace(
        'capability "' + capId + '.skillsHome" runtime.configHome',
        ctx + '.skillsHome',
      ));
    }
  }

  return errors;
}

/**
 * Validate a single ArtifactKind entry per ADR-1016 Decision 3.
 * Returns an array of error strings.
 *
 * @param {string} capId   Capability id (for error messages)
 * @param {*}      entry   The ArtifactKind object
 * @param {string} prefix  Path prefix for error messages (e.g. "artifactLayout.global[0]")
 * @returns {string[]}
 */
function validateArtifactKindEntry(capId, entry, prefix) {
  const errors = [];
  const ctx = 'capability "' + capId + '" runtime.' + prefix;

  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    errors.push(ctx + ' must be an object');
    return errors;
  }

  // kind — must be in closed vocab; inline literal guard (CodeQL barrier)
  if (entry.kind === '__proto__' || entry.kind === 'constructor' || entry.kind === 'prototype') {
    errors.push(ctx + '.kind "' + entry.kind + '" is a reserved name');
  } else if (!VALID_ARTIFACT_KIND_NAMES.has(entry.kind)) {
    errors.push(
      ctx + '.kind must be one of: ' + [...VALID_ARTIFACT_KIND_NAMES].join(', ') +
      ' (got: ' + JSON.stringify(entry.kind) + ')',
    );
  }

  // destSubpath — required non-empty string
  if (typeof entry.destSubpath !== 'string' || entry.destSubpath.length === 0) {
    errors.push(ctx + '.destSubpath must be a non-empty string');
  }

  // nesting — required; must be in closed vocab (ADR-857 §5d: now drives install)
  if (entry.nesting === undefined || entry.nesting === null) {
    errors.push(ctx + '.nesting is required and must be one of: ' + [...VALID_ARTIFACT_NESTINGS].join(', '));
  } else if (!VALID_ARTIFACT_NESTINGS.has(entry.nesting)) {
    errors.push(
      ctx + '.nesting must be one of: ' + [...VALID_ARTIFACT_NESTINGS].join(', ') +
      ' (got: ' + JSON.stringify(entry.nesting) + ')',
    );
  }

  // prefix — required; must be a string (may be empty string '')
  if (entry.prefix === undefined || entry.prefix === null) {
    errors.push(ctx + '.prefix is required (must be a string, may be empty)');
  } else if (typeof entry.prefix !== 'string') {
    errors.push(ctx + '.prefix must be a string (got: ' + typeof entry.prefix + ')');
  }

  // recursive — optional; if present must be a boolean
  if (entry.recursive !== undefined) {
    if (typeof entry.recursive !== 'boolean') {
      errors.push(ctx + '.recursive must be a boolean if present (got: ' + typeof entry.recursive + ')');
    }
  }

  // converter — required; must be a string or null (closed ConverterName enum — now enforced in phase 5e)
  if (!Object.prototype.hasOwnProperty.call(entry, 'converter')) {
    errors.push(ctx + '.converter is required (must be a string or null)');
  } else if (entry.converter !== null && typeof entry.converter !== 'string') {
    errors.push(ctx + '.converter must be a string or null (got: ' + typeof entry.converter + ')');
  } else if (entry.converter !== null && typeof entry.converter === 'string' &&
             !VALID_CONVERTER_NAMES.has(entry.converter)) {
    // Closed ConverterName enum (ADR-857 phase 5e): reject unknown converter names
    errors.push(ctx + '.converter "' + entry.converter + '" is not a known ConverterName');
  }

  return errors;
}

/**
 * Validate runtime.artifactLayout per ADR-1016 Decision 3.
 * Accepts the structured { global, local } shape.
 * Returns an array of error strings.
 *
 * @param {string} capId  Capability id (for error messages)
 * @param {*}      layout The artifactLayout value
 * @returns {string[]}
 */
function validateArtifactLayout(capId, layout) {
  const errors = [];
  const ctx = 'capability "' + capId + '" runtime.artifactLayout';

  if (typeof layout !== 'object' || layout === null || Array.isArray(layout)) {
    errors.push(ctx + ' must be an object with "global" and "local" arrays');
    return errors;
  }

  for (const scope of ['global', 'local']) {
    const arr = layout[scope];
    if (!Array.isArray(arr)) {
      errors.push(ctx + '.' + scope + ' must be an array');
    } else {
      for (let i = 0; i < arr.length; i++) {
        errors.push(...validateArtifactKindEntry(capId, arr[i], 'artifactLayout.' + scope + '[' + i + ']'));
      }
    }
  }

  return errors;
}

function validateRuntimeBody(cap) {
  const errors = [];

  // C3: feature-only fields must NOT appear on a runtime cap
  for (const field of FEATURE_FIELDS_FORBIDDEN_ON_RUNTIME) {
    if (cap[field] !== undefined) {
      errors.push('role:runtime capability must not have "' + field + '" (feature-only field)');
    }
  }

  // C3: require a runtime object
  if (typeof cap.runtime !== 'object' || cap.runtime === null || Array.isArray(cap.runtime)) {
    errors.push('role:runtime capability must have a "runtime" object');
    return errors; // can't validate further without the object
  }

  const r = cap.runtime;

  // configHome — must be a structured object (ADR-1016 Decision 1)
  errors.push(...validateConfigHome(cap.id || '(unknown)', r.configHome));

  // configFormat — closed 5-enum (unchanged)
  if (!VALID_CONFIG_FORMATS.has(r.configFormat)) {
    errors.push('runtime.configFormat must be one of: ' + [...VALID_CONFIG_FORMATS].join(', ') + ' (got: ' + r.configFormat + ')');
  }

  // artifactLayout — structured { global, local } per ADR-1016 Decision 3
  errors.push(...validateArtifactLayout(cap.id || '(unknown)', r.artifactLayout));

  // commandStyle — closed 2-enum (ADR-1016 Decision 4); inline literal guard (CodeQL barrier)
  if (r.commandStyle === '__proto__' || r.commandStyle === 'constructor' || r.commandStyle === 'prototype') {
    errors.push('runtime.commandStyle "' + r.commandStyle + '" is a reserved name');
  } else if (!VALID_COMMAND_STYLES.has(r.commandStyle)) {
    errors.push(
      'runtime.commandStyle must be one of: ' + [...VALID_COMMAND_STYLES].join(', ') +
      ' (got: ' + JSON.stringify(r.commandStyle) + ')',
    );
  }

  // hooksSurface — closed 7-enum (ADR-1016 Decision 5); inline literal guard (CodeQL barrier)
  if (r.hooksSurface === '__proto__' || r.hooksSurface === 'constructor' || r.hooksSurface === 'prototype') {
    errors.push('runtime.hooksSurface "' + r.hooksSurface + '" is a reserved name');
  } else if (!VALID_HOOKS_SURFACES.has(r.hooksSurface)) {
    errors.push(
      'runtime.hooksSurface must be one of: ' + [...VALID_HOOKS_SURFACES].join(', ') +
      ' (got: ' + JSON.stringify(r.hooksSurface) + ')',
    );
  }

  // hookEvents — optional; if present must be in closed enum (ADR-1016 Decision 5).
  // Managed-hook dialect only (claude/gemini). The OpenCode extension-system event
  // subset is NOT a hookEvents value — it is `extensionEvents` (ADR-1239 / #1943).
  if (r.hookEvents !== undefined) {
    if (r.hookEvents === '__proto__' || r.hookEvents === 'constructor' || r.hookEvents === 'prototype') {
      errors.push('runtime.hookEvents "' + r.hookEvents + '" is a reserved name');
    } else if (!VALID_HOOK_EVENTS.has(r.hookEvents)) {
      errors.push(
        'runtime.hookEvents must be one of: ' + [...VALID_HOOK_EVENTS].join(', ') +
        ' (got: ' + JSON.stringify(r.hookEvents) + ')',
      );
    }
  }

  // extensionEvents — optional; the extension-system event dialect (ADR-1239 amendment / #1943).
  // Distinct from hookEvents. Only imperative-embedding hosts (with a plugin/extension
  // API) set it; declarative hosts do not.
  if (r.extensionEvents !== undefined) {
    if (r.extensionEvents === '__proto__' || r.extensionEvents === 'constructor' || r.extensionEvents === 'prototype') {
      errors.push('runtime.extensionEvents "' + r.extensionEvents + '" is a reserved name');
    } else if (!VALID_EXTENSION_EVENTS.has(r.extensionEvents)) {
      errors.push(
        'runtime.extensionEvents must be one of: ' + [...VALID_EXTENSION_EVENTS].join(', ') +
        ' (got: ' + JSON.stringify(r.extensionEvents) + ')',
      );
    }
  }

  // sandboxTier — closed 2-enum (ADR-1016 Decision 6); inline literal guard (CodeQL barrier)
  if (r.sandboxTier === '__proto__' || r.sandboxTier === 'constructor' || r.sandboxTier === 'prototype') {
    errors.push('runtime.sandboxTier "' + r.sandboxTier + '" is a reserved name');
  } else if (!VALID_SANDBOX_TIERS.has(r.sandboxTier)) {
    errors.push(
      'runtime.sandboxTier must be one of: ' + [...VALID_SANDBOX_TIERS].join(', ') +
      ' (got: ' + JSON.stringify(r.sandboxTier) + ')',
    );
  }

  // supportTier — 1 or 2 (unchanged)
  if (r.supportTier !== 1 && r.supportTier !== 2) {
    errors.push('runtime.supportTier must be 1 or 2 (got: ' + r.supportTier + ')');
  }

  // installSurface — required string in closed enum
  if (!VALID_INSTALL_SURFACES.has(r.installSurface)) {
    errors.push(
      'runtime.installSurface must be one of: ' + [...VALID_INSTALL_SURFACES].join(', ') +
      ' (got: ' + JSON.stringify(r.installSurface) + ')',
    );
  }

  // writesSharedSettings — required boolean
  if (typeof r.writesSharedSettings !== 'boolean') {
    errors.push(
      'runtime.writesSharedSettings must be a boolean (got: ' + JSON.stringify(r.writesSharedSettings) + ')',
    );
  }

  // permissionWriter — required key; value must be null or a string in VALID_PERMISSION_WRITERS
  if (!Object.prototype.hasOwnProperty.call(r, 'permissionWriter')) {
    errors.push('runtime.permissionWriter is required (must be null or one of: ' + [...VALID_PERMISSION_WRITERS].join(', ') + ')');
  } else if (r.permissionWriter !== null && !VALID_PERMISSION_WRITERS.has(r.permissionWriter)) {
    errors.push(
      'runtime.permissionWriter must be null or one of: ' + [...VALID_PERMISSION_WRITERS].join(', ') +
      ' (got: ' + JSON.stringify(r.permissionWriter) + ')',
    );
  }

  // localConfigDir — REQUIRED non-empty dot-dir string (ADR-1239 Phase B #1679)
  // Must start with '.' (e.g. ".claude", ".cursor"). Validated here so the registry
  // generator catches any descriptor missing the field before regenerating.
  //
  // #2103: conditional on configHome.kind !== 'none' — a Marketplace/VSIX
  // host with no file-projected config directory (e.g. VS Code) has no
  // local dir to name; localConfigDir may be null/absent for such runtimes.
  const configHomeKind = (r.configHome && typeof r.configHome === 'object') ? r.configHome.kind : undefined;
  if (configHomeKind !== 'none') {
    if (typeof r.localConfigDir !== 'string' || r.localConfigDir.length === 0) {
      errors.push(
        'runtime.localConfigDir is required and must be a non-empty string (e.g. ".claude"); ' +
        'got: ' + JSON.stringify(r.localConfigDir),
      );
    } else if (!r.localConfigDir.startsWith('.')) {
      errors.push(
        'runtime.localConfigDir must start with "." (a dot-dir); got: ' + JSON.stringify(r.localConfigDir),
      );
    }
  } else if (r.localConfigDir !== null && r.localConfigDir !== undefined) {
    errors.push(
      'runtime.localConfigDir must be null or absent when configHome.kind is "none"; ' +
      'got: ' + JSON.stringify(r.localConfigDir),
    );
  }

  // extendedHookEvents — required array; every element must be in closed enum
  if (!Array.isArray(r.extendedHookEvents)) {
    errors.push(
      'runtime.extendedHookEvents must be an array (got: ' + JSON.stringify(r.extendedHookEvents) + ')',
    );
  } else {
    for (let i = 0; i < r.extendedHookEvents.length; i++) {
      const ev = r.extendedHookEvents[i];
      if (typeof ev !== 'string' || !VALID_EXTENDED_HOOK_EVENTS.has(ev)) {
        errors.push(
          'runtime.extendedHookEvents[' + i + '] must be one of: ' + [...VALID_EXTENDED_HOOK_EVENTS].join(', ') +
          ' (got: ' + JSON.stringify(ev) + ')',
        );
      }
    }
  }

  // hostIntegration — ADR-1239 Phase A: required object with closed-enum axes
  if (typeof r.hostIntegration !== 'object' || r.hostIntegration === null || Array.isArray(r.hostIntegration)) {
    errors.push('runtime.hostIntegration is required and must be an object');
  } else {
    const hi = r.hostIntegration;

    // S2b: reserved-OWN-KEY guard on hostIntegration (CodeQL barrier — inline literal comparisons)
    if (Object.prototype.hasOwnProperty.call(hi, '__proto__')) {
      errors.push('runtime.hostIntegration must not contain reserved key "__proto__"');
    }
    if (Object.prototype.hasOwnProperty.call(hi, 'constructor')) {
      errors.push('runtime.hostIntegration must not contain reserved key "constructor"');
    }
    if (Object.prototype.hasOwnProperty.call(hi, 'prototype')) {
      errors.push('runtime.hostIntegration must not contain reserved key "prototype"');
    }

    // embeddingMode
    if (hi.embeddingMode === '__proto__' || hi.embeddingMode === 'constructor' || hi.embeddingMode === 'prototype') {
      errors.push('runtime.hostIntegration.embeddingMode "' + hi.embeddingMode + '" is a reserved name');
    } else if (hi.embeddingMode !== 'undocumented' && !VALID_EMBEDDING_MODES.has(hi.embeddingMode)) {
      errors.push(
        'runtime.hostIntegration.embeddingMode must be one of: ' + [...VALID_EMBEDDING_MODES].join(', ') +
        ' (or "undocumented") (got: ' + JSON.stringify(hi.embeddingMode) + ')',
      );
    }

    // commandSurface
    if (hi.commandSurface === '__proto__' || hi.commandSurface === 'constructor' || hi.commandSurface === 'prototype') {
      errors.push('runtime.hostIntegration.commandSurface "' + hi.commandSurface + '" is a reserved name');
    } else if (hi.commandSurface !== 'undocumented' && !VALID_COMMAND_SURFACES.has(hi.commandSurface)) {
      errors.push(
        'runtime.hostIntegration.commandSurface must be one of: ' + [...VALID_COMMAND_SURFACES].join(', ') +
        ' (or "undocumented") (got: ' + JSON.stringify(hi.commandSurface) + ')',
      );
    }

    // modelMode
    if (hi.modelMode === '__proto__' || hi.modelMode === 'constructor' || hi.modelMode === 'prototype') {
      errors.push('runtime.hostIntegration.modelMode "' + hi.modelMode + '" is a reserved name');
    } else if (hi.modelMode !== 'undocumented' && !VALID_MODEL_MODES.has(hi.modelMode)) {
      errors.push(
        'runtime.hostIntegration.modelMode must be one of: ' + [...VALID_MODEL_MODES].join(', ') +
        ' (or "undocumented") (got: ' + JSON.stringify(hi.modelMode) + ')',
      );
    }

    // hookBus
    if (hi.hookBus === '__proto__' || hi.hookBus === 'constructor' || hi.hookBus === 'prototype') {
      errors.push('runtime.hostIntegration.hookBus "' + hi.hookBus + '" is a reserved name');
    } else if (hi.hookBus !== 'undocumented' && !VALID_HOOK_BUSES.has(hi.hookBus)) {
      errors.push(
        'runtime.hostIntegration.hookBus must be one of: ' + [...VALID_HOOK_BUSES].join(', ') +
        ' (or "undocumented") (got: ' + JSON.stringify(hi.hookBus) + ')',
      );
    }

    // stateIO
    if (hi.stateIO === '__proto__' || hi.stateIO === 'constructor' || hi.stateIO === 'prototype') {
      errors.push('runtime.hostIntegration.stateIO "' + hi.stateIO + '" is a reserved name');
    } else if (hi.stateIO !== 'undocumented' && !VALID_STATE_IO.has(hi.stateIO)) {
      errors.push(
        'runtime.hostIntegration.stateIO must be one of: ' + [...VALID_STATE_IO].join(', ') +
        ' (or "undocumented") (got: ' + JSON.stringify(hi.stateIO) + ')',
      );
    }

    // transport
    if (hi.transport === '__proto__' || hi.transport === 'constructor' || hi.transport === 'prototype') {
      errors.push('runtime.hostIntegration.transport "' + hi.transport + '" is a reserved name');
    } else if (hi.transport !== 'undocumented' && !VALID_TRANSPORTS.has(hi.transport)) {
      errors.push(
        'runtime.hostIntegration.transport must be one of: ' + [...VALID_TRANSPORTS].join(', ') +
        ' (or "undocumented") (got: ' + JSON.stringify(hi.transport) + ')',
      );
    }

    // runtime (axis)
    if (hi.runtime === '__proto__' || hi.runtime === 'constructor' || hi.runtime === 'prototype') {
      errors.push('runtime.hostIntegration.runtime "' + hi.runtime + '" is a reserved name');
    } else if (hi.runtime !== 'undocumented' && !VALID_HOST_RUNTIMES.has(hi.runtime)) {
      errors.push(
        'runtime.hostIntegration.runtime must be one of: ' + [...VALID_HOST_RUNTIMES].join(', ') +
        ' (or "undocumented") (got: ' + JSON.stringify(hi.runtime) + ')',
      );
    }

    // effortSurface (axis) — ADR-1239 amendment (#2481).
    // OPTIONAL, unlike the Phase-A axes. It was added after descriptors already
    // existed, so requiring it would invalidate every descriptor written before it —
    // including third-party ones, breaking the "purely additive" property ADR-1239
    // promises for external descriptors. An omitted axis is legitimate: negotiation
    // degrades it to the safe floor ('none') and warns, exactly as for any
    // undeclared axis. Only a PRESENT value is checked against the vocabulary.
    if (hi.effortSurface === undefined) {
      // absent — nothing to validate; negotiateHostCapabilities fails it closed.
    } else if (hi.effortSurface === '__proto__' || hi.effortSurface === 'constructor' || hi.effortSurface === 'prototype') {
      errors.push('runtime.hostIntegration.effortSurface "' + hi.effortSurface + '" is a reserved name');
    } else if (hi.effortSurface !== 'undocumented' && !VALID_EFFORT_SURFACES.has(hi.effortSurface)) {
      errors.push(
        'runtime.hostIntegration.effortSurface must be one of: ' + [...VALID_EFFORT_SURFACES].join(', ') +
        ' (or "undocumented") (got: ' + JSON.stringify(hi.effortSurface) + ')',
      );
    }

    // dispatch — required object
    if (typeof hi.dispatch !== 'object' || hi.dispatch === null || Array.isArray(hi.dispatch)) {
      errors.push('runtime.hostIntegration.dispatch must be an object');
    } else {
      const d = hi.dispatch;

      // S2b: reserved-OWN-KEY guard on dispatch (CodeQL barrier — inline literal comparisons)
      if (Object.prototype.hasOwnProperty.call(d, '__proto__')) {
        errors.push('runtime.hostIntegration.dispatch must not contain reserved key "__proto__"');
      }
      if (Object.prototype.hasOwnProperty.call(d, 'constructor')) {
        errors.push('runtime.hostIntegration.dispatch must not contain reserved key "constructor"');
      }
      if (Object.prototype.hasOwnProperty.call(d, 'prototype')) {
        errors.push('runtime.hostIntegration.dispatch must not contain reserved key "prototype"');
      }

      // namedDispatch — boolean or 'undocumented'
      if (typeof d.namedDispatch !== 'boolean' && d.namedDispatch !== 'undocumented') {
        errors.push(
          'runtime.hostIntegration.dispatch.namedDispatch must be a boolean or "undocumented" (got: ' + JSON.stringify(d.namedDispatch) + ')',
        );
      }

      // nested — boolean or 'undocumented'
      if (typeof d.nested !== 'boolean' && d.nested !== 'undocumented') {
        errors.push(
          'runtime.hostIntegration.dispatch.nested must be a boolean or "undocumented" (got: ' + JSON.stringify(d.nested) + ')',
        );
      }

      // background — boolean or 'undocumented'
      if (typeof d.background !== 'boolean' && d.background !== 'undocumented') {
        errors.push(
          'runtime.hostIntegration.dispatch.background must be a boolean or "undocumented" (got: ' + JSON.stringify(d.background) + ')',
        );
      }

      // subagentToolkit — closed enum or 'undocumented'
      if (d.subagentToolkit === '__proto__' || d.subagentToolkit === 'constructor' || d.subagentToolkit === 'prototype') {
        errors.push('runtime.hostIntegration.dispatch.subagentToolkit "' + d.subagentToolkit + '" is a reserved name');
      } else if (d.subagentToolkit !== 'undocumented' && !VALID_SUBAGENT_TOOLKITS.has(d.subagentToolkit)) {
        errors.push(
          'runtime.hostIntegration.dispatch.subagentToolkit must be one of: ' + [...VALID_SUBAGENT_TOOLKITS].join(', ') +
          ' (or "undocumented") (got: ' + JSON.stringify(d.subagentToolkit) + ')',
        );
      }

      // maxDepth — integer >= -1 or 'undocumented'
      if (d.maxDepth !== 'undocumented' && (!Number.isInteger(d.maxDepth) || d.maxDepth < -1)) {
        errors.push(
          'runtime.hostIntegration.dispatch.maxDepth must be an integer >= -1 or "undocumented" (got: ' + JSON.stringify(d.maxDepth) + ')',
        );
      }

      // backgroundDispatch — REQUIRED (all 16 runtime descriptors carry it, matching the sibling fields
      // namedDispatch/nested/background/subagentToolkit/maxDepth which are all required).
      if (!Object.prototype.hasOwnProperty.call(d, 'backgroundDispatch')) {
        errors.push(
          'runtime.hostIntegration.dispatch.backgroundDispatch is required (must be a boolean or "undocumented")',
        );
      } else if (typeof d.backgroundDispatch !== 'boolean' && d.backgroundDispatch !== 'undocumented') {
        errors.push(
          'runtime.hostIntegration.dispatch.backgroundDispatch must be a boolean or "undocumented" (got: ' + JSON.stringify(d.backgroundDispatch) + ')',
        );
      }

      // isolation — ADR-1239 Codex-binding amendment (#2584).
      // OPTIONAL, like effortSurface: added after descriptors already existed,
      // so requiring it would invalidate every descriptor authored before it —
      // including third-party ones, breaking the "purely additive" property
      // ADR-1239 promises for external descriptors. An omitted isolation is
      // legitimate: negotiation degrades it to 'none' (the safe floor) and
      // warns, exactly as for any other undeclared dispatch sub-field. Only a
      // PRESENT value is checked against the closed vocabulary.
      if (d.isolation === undefined) {
        // absent — nothing to validate; negotiateHostCapabilities fails it closed.
      } else if (d.isolation === '__proto__' || d.isolation === 'constructor' || d.isolation === 'prototype') {
        errors.push('runtime.hostIntegration.dispatch.isolation "' + d.isolation + '" is a reserved name');
      } else if (d.isolation !== 'undocumented' && !VALID_DISPATCH_ISOLATION.has(d.isolation)) {
        errors.push(
          'runtime.hostIntegration.dispatch.isolation must be one of: ' + [...VALID_DISPATCH_ISOLATION].join(', ') +
          ' (or "undocumented") (got: ' + JSON.stringify(d.isolation) + ')',
        );
      }
    }
  }

  // orchestratorExec — ADR-1239 Codex-binding amendment (#2584), Phase 2.
  // OPTIONAL top-level field (sibling of hostBehaviors), like hookEvents:
  // only hosts whose hostIntegration.dispatch.isolation is
  // 'orchestrator-worktree' need it, so it is not required on every runtime
  // descriptor. When present it must be a well-formed exec descriptor for
  // src/host-integration.cts's resolveOrchestratorExec.
  if (r.orchestratorExec !== undefined) {
    if (typeof r.orchestratorExec !== 'object' || r.orchestratorExec === null || Array.isArray(r.orchestratorExec)) {
      errors.push(
        'runtime.orchestratorExec must be an object (got: ' +
        (r.orchestratorExec === null ? 'null' : (Array.isArray(r.orchestratorExec) ? 'array' : typeof r.orchestratorExec)) + ')',
      );
    } else {
      const oe = r.orchestratorExec;

      // S2b: reserved-OWN-KEY guard (CodeQL barrier — inline literal comparisons)
      if (Object.prototype.hasOwnProperty.call(oe, '__proto__')) {
        errors.push('runtime.orchestratorExec must not contain reserved key "__proto__"');
      }
      if (Object.prototype.hasOwnProperty.call(oe, 'constructor')) {
        errors.push('runtime.orchestratorExec must not contain reserved key "constructor"');
      }
      if (Object.prototype.hasOwnProperty.call(oe, 'prototype')) {
        errors.push('runtime.orchestratorExec must not contain reserved key "prototype"');
      }

      // command — required non-empty string; reserved-name guard (CodeQL barrier)
      if (oe.command === '__proto__' || oe.command === 'constructor' || oe.command === 'prototype') {
        errors.push('runtime.orchestratorExec.command "' + oe.command + '" is a reserved name');
      } else if (typeof oe.command !== 'string' || oe.command.length === 0) {
        errors.push(
          'runtime.orchestratorExec.command must be a non-empty string (got: ' + JSON.stringify(oe.command) + ')',
        );
      }

      // args — optional array of strings
      if (oe.args !== undefined) {
        if (!Array.isArray(oe.args) || !oe.args.every((a) => typeof a === 'string')) {
          errors.push(
            'runtime.orchestratorExec.args must be an array of strings (got: ' + JSON.stringify(oe.args) + ')',
          );
        }
      }

      // cwdFlag — optional; string or null
      if (oe.cwdFlag !== undefined && oe.cwdFlag !== null && typeof oe.cwdFlag !== 'string') {
        errors.push(
          'runtime.orchestratorExec.cwdFlag must be a string or null (got: ' + JSON.stringify(oe.cwdFlag) + ')',
        );
      }

      // promptFlag — optional; string or null (#2627, Phase 3). `null`/absent
      // means the host takes the executor prompt positionally (codex, opencode);
      // a string names the flag that carries it (kimi/kimi-code: --prompt).
      if (oe.promptFlag !== undefined && oe.promptFlag !== null && typeof oe.promptFlag !== 'string') {
        errors.push(
          'runtime.orchestratorExec.promptFlag must be a string or null (got: ' + JSON.stringify(oe.promptFlag) + ')',
        );
      }
    }
  }

  // harnessIsolationFlag — ADR-1239 Codex-binding amendment (#2584), Phase 3
  // (#2627). OPTIONAL top-level field: the counterpart of orchestratorExec for
  // `dispatch.isolation: 'harness-worktree'` hosts, naming the host's OWN
  // isolation flag that GSD passes on dispatch (claude: isolation="worktree";
  // cursor: --worktree). Descriptor data so the scheduler passes a declared
  // token instead of branching on a runtime id (ADR-1239: "the per-host
  // dispatch invocation ... is descriptor data, not a scheduler branch").
  if (r.harnessIsolationFlag !== undefined && (typeof r.harnessIsolationFlag !== 'string' || r.harnessIsolationFlag.length === 0)) {
    errors.push(
      'runtime.harnessIsolationFlag must be a non-empty string (got: ' + JSON.stringify(r.harnessIsolationFlag) + ')',
    );
  }

  // GATE A: installSurface ↔ hooksSurface consistency (DEFECT.GENERATIVE-FIX)
  // Only check if both fields are valid strings (individual field validators above report type errors).
  if (typeof r.installSurface === 'string' && typeof r.hooksSurface === 'string') {
    const allowedHooksSurfaces = INSTALL_SURFACE_TO_ALLOWED_HOOKS_SURFACES.get(r.installSurface);
    if (allowedHooksSurfaces !== undefined && !allowedHooksSurfaces.has(r.hooksSurface)) {
      errors.push(
        'runtime.hooksSurface "' + r.hooksSurface + '" is not valid for installSurface "' + r.installSurface + '"' +
        ' — allowed: ' + [...allowedHooksSurfaces].join(', ') +
        ' (src: INSTALL_SURFACE_TO_ALLOWED_HOOKS_SURFACES in scripts/gen-capability-registry.cjs)',
      );
    }
  }

  // GATE B: extendedHookEvents ↔ hookEvents consistency (DEFECT.GENERATIVE-FIX)
  // If extendedHookEvents contains Gemini agent-events, hookEvents must be 'gemini'.
  // If it contains Claude-family events, hookEvents must be 'claude'.
  // Empty extendedHookEvents imposes no constraint.
  if (Array.isArray(r.extendedHookEvents) && r.extendedHookEvents.length > 0) {
    const hasGeminiEvents = r.extendedHookEvents.some((ev) => GEMINI_AGENT_EVENTS.has(ev));
    const hasClaudeEvents = r.extendedHookEvents.some((ev) => CLAUDE_FAMILY_EVENTS.has(ev));
    if (hasGeminiEvents && r.hookEvents !== 'gemini') {
      errors.push(
        'runtime.extendedHookEvents contains Gemini agent-events (' +
        r.extendedHookEvents.filter((ev) => GEMINI_AGENT_EVENTS.has(ev)).join(', ') +
        ') but runtime.hookEvents is "' + r.hookEvents + '" — must be "gemini"',
      );
    }
    if (hasClaudeEvents && r.hookEvents !== 'claude') {
      errors.push(
        'runtime.extendedHookEvents contains Claude-family events (' +
        r.extendedHookEvents.filter((ev) => CLAUDE_FAMILY_EVENTS.has(ev)).join(', ') +
        ') but runtime.hookEvents is "' + r.hookEvents + '" — must be "claude"',
      );
    }
  }

  return errors;
}

/**
 * ADR-2782 D2/D7 — every declared reviewer field is a known key. Anything else
 * inside the body is IGNORED WITH A WARNING (D4.3), never a validation error:
 * a capability authored for a newer GSD must degrade to discovered-but-inactive
 * rather than failing the build of a repo that merely reads it.
 */
const KNOWN_REVIEWER_FIELDS = new Set([
  'slug', 'flags', 'transport', 'probe', 'invoke', 'timeoutFloorMs', 'emptyOutput',
  'reviewsSection', 'evidenceClass', 'requiresBinaries', 'promptBudgetKey',
  // `modelConfigKey` added by Phase 5b (#2799). The model key was IMPLICIT
  // (`review.models.<slug>`) until a shipped lane broke the convention: antigravity's
  // slug is `antigravity` but its key is `review.models.agy`, so resolving by slug
  // missed a configured model and silently disabled the pinned-model escape hatch
  // #2073 added. A convention one shipped lane already violates is not a contract.
  'modelConfigKey',
  'handler',
]);

const KNOWN_PROBE_FIELDS = new Set(['kind', 'binary', 'needle', 'timeoutMs', 'hostConfigKey', 'path']);

/** A bounded probe timeout must be a finite, positive INTEGER of milliseconds. */
function isPositiveIntegerMs(v) {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/**
 * Render any value for an error message WITHOUT ever throwing.
 *
 * `JSON.stringify` throws on a BigInt and on a circular structure, and a value
 * carrying a throwing `toJSON` propagates that throw. Interpolating a rejected
 * value into its own rejection message must never itself become the failure —
 * these validators are contracted to RETURN errors, and #1461 OVL-1 records a
 * validator that threw and would have crashed every consumer of loadRegistry.
 *
 * @param {*} v
 * @returns {string}
 */
function describeValue(v) {
  if (typeof v === 'bigint') return String(v) + 'n';
  if (typeof v === 'symbol') return String(v);
  if (typeof v === 'function') return '[function]';
  try {
    const json = JSON.stringify(v);
    // stringify returns undefined for undefined and for non-serializable roots.
    return json === undefined ? String(v) : json;
  } catch {
    // Circular structure, a nested BigInt, or a throwing toJSON.
    try {
      return Object.prototype.toString.call(v);
    } catch {
      return '[unserializable]';
    }
  }
}

/** Extract a message from an unknown thrown value without throwing again. */
function safeErrorMessage(err) {
  try {
    if (err instanceof Error && typeof err.message === 'string') return err.message;
    return describeValue(err);
  } catch {
    return '[unprintable error]';
  }
}

/** House CodeQL barrier — inline literal guard at every key-derived read/write site. */
function isReservedName(v) {
  return v === '__proto__' || v === 'constructor' || v === 'prototype';
}

/**
 * One closed-enum membership check, with the members always enumerated in the
 * error.
 *
 * The enumeration is the point, not the deduplication. The prose reference for
 * the reviewer body lands in Phase 6 (#2800), so until then these errors are the
 * only documentation of the vocabulary — exactly the gap that left
 * `hostBehaviors` discoverable solely by grepping a source line. Routing every
 * enum through one helper makes "the error names the valid members" structural
 * rather than a convention repeated at nine call sites, where it would drift.
 *
 * No reserved-name pre-check: a `VALID_*` set never contains `__proto__`,
 * `constructor` or `prototype`, so membership alone already rejects them, and
 * "must be one of: …" tells an author more than "is a reserved name". The
 * literal guards stay where they do real work — the key-derived write sites.
 *
 * @param {string} ctx       Error-message prefix.
 * @param {string} label     Dotted field path, e.g. "reviewer.transport".
 * @param {*}      value     The declared value.
 * @param {Set}    validSet  The closed vocabulary.
 * @returns {string[]}
 */
function validateEnumField(ctx, label, value, validSet) {
  if (validSet.has(value)) return [];
  return [
    ctx + ' ' + label + ' must be one of: ' + [...validSet].join(', ') +
    ' (got: ' + describeValue(value) + ')',
  ];
}

/**
 * Collect NON-FATAL diagnostics for a reviewer body (ADR-2782 D4.3).
 *
 * Kept separate from validateReviewerBody so validateCapability's contract
 * (`=> string[]` of ERRORS) is unchanged for its two existing callers. The
 * build-time generator writes these to stderr; the overlay loader surfaces them
 * through OverlayMeta.warnings. A warning written only to a build log nobody
 * reads is not a warning (ADR-2782 D4, "Where warnings surface").
 *
 * @param {object} cap  A capability manifest.
 * @returns {string[]}  Warning strings; empty when there is nothing to say.
 */
function collectReviewerWarnings(cap) {
  // Same totality contract as validateReviewerBody, for the same reason: this is
  // called from loadRegistry's accept path, and a diagnostic that throws must
  // never cost the user a working lane.
  try {
    return collectReviewerWarningFields(cap);
  } catch {
    return [];
  }
}

function collectReviewerWarningFields(cap) {
  const warnings = [];
  if (typeof cap !== 'object' || cap === null || Array.isArray(cap)) return warnings;
  const r = cap.reviewer;
  if (typeof r !== 'object' || r === null || Array.isArray(r)) return warnings;

  const capId = typeof cap.id === 'string' ? cap.id : '(unknown)';
  for (const key of Object.keys(r)) {
    if (isReservedName(key) || KNOWN_REVIEWER_FIELDS.has(key)) continue;
    warnings.push(
      '⚠ capability "' + capId + '" reviewer.' + key + ' is not a known reviewer field ' +
      'in this GSD version — ignored. Known fields: ' + [...KNOWN_REVIEWER_FIELDS].join(', '),
    );
  }
  return warnings;
}

/**
 * Validate a `reviewer` lane body (ADR-2782 D1/D2/D3/D6/D7).
 *
 * TOTAL: returns an array of error strings for ANY input and never throws. The
 * overlay loader contracts every validator to RETURN errors — #1461 OVL-1
 * records a validator that THREW and would have crashed every consumer of
 * loadRegistry. That contract is load-bearing, not stylistic.
 *
 * ABSENT-SAFE (D4.1): a capability with no `reviewer` key is simply not a lane.
 * That is NEVER an error — 39 of 39 shipped capabilities are in this state, and
 * a validator that errors here breaks the entire registry. `undefined` is the
 * ONLY permissive case: `null`, `{}`, `[]`, `false` and `0` are all assertions
 * of a body, and a malformed assertion is an error (Postel's Law with a
 * boundary — liberal in what a manifest may OMIT, strict in what it ASSERTS).
 *
 * Totality is enforced STRUCTURALLY by the wrapper below, not by auditing every
 * field read. Serialization is made safe via describeValue(), but that alone is
 * not enough: a value carrying a throwing getter, or a Proxy with a throwing
 * `get`/`ownKeys` trap, throws on the READ itself, before any message is built.
 * A caller cannot be asked to re-derive today's reachability analysis — the
 * contract says "any input", so the guarantee is absolute rather than argued.
 *
 * @param {object} cap  The parsed capability manifest.
 * @returns {string[]}  Array of error strings; empty = valid.
 */
function validateReviewerBody(cap) {
  try {
    return validateReviewerBodyFields(cap);
  } catch (err) {
    // A malformed body must degrade to a validation ERROR, never to a crash of
    // every consumer of loadRegistry (#1461 OVL-1).
    return ['capability reviewer body could not be validated: ' + safeErrorMessage(err)];
  }
}

function validateReviewerBodyFields(cap) {
  const errors = [];
  if (typeof cap !== 'object' || cap === null || Array.isArray(cap)) return errors;

  const r = cap.reviewer;
  if (r === undefined) return errors; // D4.1 — not a lane. Never an error.

  const ctx = 'capability "' + (typeof cap.id === 'string' ? cap.id : '(unknown)') + '"';

  if (typeof r !== 'object' || r === null || Array.isArray(r)) {
    const got = r === null ? 'null' : Array.isArray(r) ? 'array' : typeof r;
    errors.push(
      ctx + ' reviewer must be an object (got: ' + got + '). ' +
      'Omit the key entirely to declare no lane — an explicit null is not an omission.',
    );
    return errors; // cannot validate fields of a non-object
  }

  // ── slug ───────────────────────────────────────────────────────────────────
  // NOT a capability id: ids are kebab, slugs carry the roster's snake forms.
  if (typeof r.slug !== 'string' || r.slug.length === 0) {
    errors.push(ctx + ' reviewer.slug must be a non-empty string');
  } else if (isReservedName(r.slug)) {
    errors.push(ctx + ' reviewer.slug "' + r.slug + '" is a reserved name');
  } else if (!LANE_SLUG_RE.test(r.slug)) {
    errors.push(
      ctx + ' reviewer.slug "' + r.slug + '" must match ' + String(LANE_SLUG_RE) +
      ' (lower-case; "_" and "-" permitted — a slug is not a capability id and not a flag)',
    );
  }

  // ── flags ──────────────────────────────────────────────────────────────────
  if (!Array.isArray(r.flags)) {
    errors.push(ctx + ' reviewer.flags must be an array of CLI flags');
  } else if (r.flags.length === 0) {
    errors.push(
      ctx + ' reviewer.flags must declare at least one flag — a lane nobody can name ' +
      'cannot be explicitly selected, so ADR-2782 D4\'s explicit-selection rule is unreachable for it',
    );
  } else {
    const seen = new Set();
    for (const flag of r.flags) {
      if (typeof flag !== 'string' || !LANE_FLAG_RE.test(flag)) {
        errors.push(
          ctx + ' reviewer.flags entry ' + describeValue(flag) +
          ' must match ' + String(LANE_FLAG_RE) + ' (e.g. "--lm-studio")',
        );
        continue;
      }
      if (seen.has(flag)) {
        errors.push(ctx + ' reviewer.flags lists "' + flag + '" more than once');
      }
      seen.add(flag);
    }
  }

  // ── transport (D2) — explicit discriminator, never inferred ────────────────
  errors.push(...validateEnumField(ctx, 'reviewer.transport', r.transport, VALID_LANE_TRANSPORTS));

  errors.push(...validateLaneProbe(ctx, r.probe));
  errors.push(...validateLaneInvoke(ctx, r.transport, r.invoke));

  // ── lane scalars ───────────────────────────────────────────────────────────
  if (!isPositiveIntegerMs(r.timeoutFloorMs)) {
    errors.push(
      ctx + ' reviewer.timeoutFloorMs must be a positive integer of milliseconds ' +
      '(got: ' + describeValue(r.timeoutFloorMs) + ')',
    );
  }

  errors.push(...validateEnumField(ctx, 'reviewer.emptyOutput', r.emptyOutput, VALID_EMPTY_OUTPUT));

  if (typeof r.reviewsSection !== 'string' || r.reviewsSection.length === 0) {
    errors.push(ctx + ' reviewer.reviewsSection must be a non-empty string');
  }

  errors.push(...validateEnumField(ctx, 'reviewer.evidenceClass', r.evidenceClass, VALID_EVIDENCE_CLASSES));

  if (!Array.isArray(r.requiresBinaries)) {
    errors.push(
      ctx + ' reviewer.requiresBinaries must be an array (use [] when the lane needs no ' +
      'external tool on PATH). Note the name: the envelope\'s "requires" is capability ids',
    );
  } else {
    for (const bin of r.requiresBinaries) {
      if (typeof bin !== 'string' || bin.length === 0) {
        errors.push(ctx + ' reviewer.requiresBinaries entry ' + describeValue(bin) + ' must be a non-empty string');
      }
    }
  }

  // OPTIONAL, and that is required by D4 rather than a convenience: `modelConfigKey` did not exist
  // before Phase 5b, so demanding it would fail validation on every reviewer manifest authored
  // against an earlier GSD — exactly the forward/backward-compatibility break D4 rule 2 forbids.
  // Absent is read as `null` (this lane accepts no model override). `null` is explicit; an empty
  // string is neither, and is rejected.
  if (r.modelConfigKey !== undefined && r.modelConfigKey !== null &&
      (typeof r.modelConfigKey !== 'string' || r.modelConfigKey.length === 0)) {
    errors.push(
      ctx + ' reviewer.modelConfigKey must be a dotted config key or null ' +
      '(got: ' + describeValue(r.modelConfigKey) + ')',
    );
  }

  // `null` is the declared "no per-lane budget"; an empty string is not.
  if (r.promptBudgetKey !== null && (typeof r.promptBudgetKey !== 'string' || r.promptBudgetKey.length === 0)) {
    errors.push(
      ctx + ' reviewer.promptBudgetKey must be a dotted config key or null ' +
      '(got: ' + describeValue(r.promptBudgetKey) + ')',
    );
  }

  // ── handler (D6) — closed first-party enum; null is the default ────────────
  if (r.handler !== null && !VALID_LANE_HANDLERS.has(r.handler)) {
    errors.push(
      ctx + ' reviewer.handler must be null or one of: ' + [...VALID_LANE_HANDLERS].join(', ') +
      ' (got: ' + describeValue(r.handler) + '). Handlers are first-party module NAMES, ' +
      'never paths and never third-party code — a lane needing a shape the vocabulary lacks ' +
      'files an issue naming the missing primitive (ADR-2782 D6)',
    );
  }

  return errors;
}

/**
 * ADR-2782 D7 — probe.kind is a closed enum WIDER than existence, and every
 * probe that starts a process or a connection MUST be bounded.
 *
 * `command-exists` alone is structurally insufficient: `kimi` is claimed by both
 * Kimi Code CLI and the legacy Python kimi-cli (a separate first-party runtime
 * capability in this repo), so an existence-only probe registers the wrong tool.
 * The unbounded form of that probe was a live instance of this repo's named
 * Unbounded Subprocesses defect — it ran on EVERY /gsd:review invocation
 * regardless of which flags were passed, so a binary waiting on a first-run auth
 * prompt hung every future review, including reviews that never asked for it.
 *
 * @param {string} ctx    Error-message prefix.
 * @param {*}      probe  The probe value.
 * @returns {string[]}
 */
function validateLaneProbe(ctx, probe) {
  const errors = [];

  if (typeof probe !== 'object' || probe === null || Array.isArray(probe)) {
    errors.push(ctx + ' reviewer.probe must be an object with a "kind" from: ' + [...VALID_LANE_PROBE_KINDS].join(', '));
    return errors;
  }

  const kindErrors = validateEnumField(ctx, 'reviewer.probe.kind', probe.kind, VALID_LANE_PROBE_KINDS);
  if (kindErrors.length > 0) {
    errors.push(...kindErrors);
    return errors; // sub-shape is meaningless without a known kind
  }

  for (const key of Object.keys(probe)) {
    if (!isReservedName(key) && !KNOWN_PROBE_FIELDS.has(key)) {
      errors.push(ctx + ' reviewer.probe.' + key + ' is not a known probe field');
    }
  }

  const needsBound = probe.kind === 'command-capability' || probe.kind === 'http-reachable';

  if (probe.kind === 'command-exists' || probe.kind === 'command-capability') {
    if (typeof probe.binary !== 'string' || probe.binary.length === 0) {
      errors.push(ctx + ' reviewer.probe.binary must be a non-empty string for kind "' + probe.kind + '"');
    }
  } else if (probe.binary !== undefined) {
    errors.push(ctx + ' reviewer.probe.binary is not permitted for kind "' + probe.kind + '"');
  }

  if (probe.kind === 'command-capability') {
    if (typeof probe.needle !== 'string' || probe.needle.length === 0) {
      errors.push(ctx + ' reviewer.probe.needle must be a non-empty string for kind "command-capability"');
    }
  } else if (probe.needle !== undefined) {
    errors.push(ctx + ' reviewer.probe.needle is not permitted for kind "' + probe.kind + '"');
  }

  if (probe.kind === 'http-reachable') {
    if (typeof probe.hostConfigKey !== 'string' || probe.hostConfigKey.length === 0) {
      errors.push(ctx + ' reviewer.probe.hostConfigKey must be a non-empty string for kind "http-reachable"');
    }
    if (typeof probe.path !== 'string' || probe.path.length === 0) {
      errors.push(ctx + ' reviewer.probe.path must be a non-empty string for kind "http-reachable"');
    }
  } else {
    if (probe.hostConfigKey !== undefined) {
      errors.push(ctx + ' reviewer.probe.hostConfigKey is not permitted for kind "' + probe.kind + '"');
    }
    if (probe.path !== undefined) {
      errors.push(ctx + ' reviewer.probe.path is not permitted for kind "' + probe.kind + '"');
    }
  }

  if (needsBound) {
    if (!isPositiveIntegerMs(probe.timeoutMs)) {
      errors.push(
        ctx + ' reviewer.probe.timeoutMs must be a positive integer of milliseconds for kind "' +
        probe.kind + '" — an unbounded probe hangs every /gsd:review invocation ' +
        '(got: ' + describeValue(probe.timeoutMs) + ')',
      );
    }
  } else if (probe.timeoutMs !== undefined) {
    errors.push(
      ctx + ' reviewer.probe.timeoutMs is not permitted for kind "command-exists" — ' +
      'no process is started, so there is nothing to bound',
    );
  }

  return errors;
}

/**
 * ADR-2782 D2 — the invoke sub-shape is selected by `transport`. A manifest
 * declaring fields from BOTH sub-shapes, or from NEITHER, fails validation:
 * inference from field presence leaves those two cases carrying undefined
 * meaning, which is exactly what a closed vocabulary exists to prevent.
 *
 * @param {string} ctx        Error-message prefix.
 * @param {*}      transport  The (already enum-checked) transport value.
 * @param {*}      invoke     The invoke value.
 * @returns {string[]}
 */
function validateLaneInvoke(ctx, transport, invoke) {
  const errors = [];

  if (typeof invoke !== 'object' || invoke === null || Array.isArray(invoke)) {
    errors.push(ctx + ' reviewer.invoke must be an object');
    return errors;
  }

  const hasSpawnField = SPAWN_ONLY_INVOKE_FIELDS.some((f) => invoke[f] !== undefined);
  const hasHttpField = HTTP_ONLY_INVOKE_FIELDS.some((f) => invoke[f] !== undefined);

  if (hasSpawnField && hasHttpField) {
    errors.push(
      ctx + ' reviewer.invoke mixes spawn-only fields (' + SPAWN_ONLY_INVOKE_FIELDS.join(', ') +
      ') with openai-http-only fields (' + HTTP_ONLY_INVOKE_FIELDS.join(', ') +
      ') — a lane is one transport or the other',
    );
  }

  if (transport === 'spawn') {
    for (const f of HTTP_ONLY_INVOKE_FIELDS) {
      if (invoke[f] !== undefined) {
        errors.push(ctx + ' reviewer.invoke.' + f + ' is not permitted for transport "spawn"');
      }
    }
    errors.push(...validateSpawnInvoke(ctx, invoke));
  } else if (transport === 'openai-http') {
    for (const f of SPAWN_ONLY_INVOKE_FIELDS) {
      if (invoke[f] !== undefined) {
        errors.push(ctx + ' reviewer.invoke.' + f + ' is not permitted for transport "openai-http"');
      }
    }
    errors.push(...validateHttpInvoke(ctx, invoke));
  }
  // transport already reported as invalid upstream — do not double-report here.

  return errors;
}

function validateSpawnInvoke(ctx, invoke) {
  const errors = [];

  if (typeof invoke.binary !== 'string' || invoke.binary.length === 0) {
    errors.push(ctx + ' reviewer.invoke.binary must be a non-empty string for transport "spawn"');
  }

  if (!Array.isArray(invoke.args)) {
    errors.push(ctx + ' reviewer.invoke.args must be an array (use [] when the lane takes no arguments)');
  } else {
    for (const a of invoke.args) {
      if (typeof a !== 'string') {
        errors.push(ctx + ' reviewer.invoke.args entry ' + describeValue(a) + ' must be a string');
      }
    }
  }

  errors.push(...validateEnumField(ctx, 'reviewer.invoke.promptChannel', invoke.promptChannel, VALID_PROMPT_CHANNELS));

  const outputChannelErrors = validateEnumField(ctx, 'reviewer.invoke.outputChannel', invoke.outputChannel, VALID_OUTPUT_CHANNELS);
  if (outputChannelErrors.length > 0) {
    errors.push(...outputChannelErrors);
  } else if (invoke.outputChannel === 'file-arg') {
    // Knowing the review lands in a file is useless without the argument naming it.
    if (typeof invoke.outputArg !== 'string' || invoke.outputArg.length === 0) {
      errors.push(
        ctx + ' reviewer.invoke.outputArg is required (non-empty string) when outputChannel is "file-arg"',
      );
    }
  } else if (invoke.outputArg !== undefined) {
    // Forbidden rather than ignored: a manifest carrying an outputArg it does not
    // use is data a later reader may honour.
    errors.push(
      ctx + ' reviewer.invoke.outputArg is only permitted when outputChannel is "file-arg" ' +
      '(got outputChannel: ' + describeValue(invoke.outputChannel) + ')',
    );
  }

  // `null` declares "this lane accepts no model override". An empty string does not.
  if (invoke.modelArg !== null && (typeof invoke.modelArg !== 'string' || invoke.modelArg.length === 0)) {
    errors.push(
      ctx + ' reviewer.invoke.modelArg must be a non-empty string or null ' +
      '(got: ' + describeValue(invoke.modelArg) + ')',
    );
  }

  errors.push(...validateEnumField(ctx, 'reviewer.invoke.effortChannel', invoke.effortChannel, VALID_LANE_EFFORT_CHANNELS));

  return errors;
}

function validateHttpInvoke(ctx, invoke) {
  const errors = [];

  if (typeof invoke.hostConfigKey !== 'string' || invoke.hostConfigKey.length === 0) {
    errors.push(
      ctx + ' reviewer.invoke.hostConfigKey must be a non-empty dotted config key ' +
      'for transport "openai-http" (it names the config key holding the base URL)',
    );
  }

  if (typeof invoke.path !== 'string' || invoke.path.length === 0) {
    errors.push(ctx + ' reviewer.invoke.path must be a non-empty string for transport "openai-http" (e.g. "/v1/chat/completions")');
  }

  errors.push(...validateEnumField(ctx, 'reviewer.invoke.modelDiscovery', invoke.modelDiscovery, VALID_MODEL_DISCOVERY));

  // D2 fixes effortChannel to 'none' for this transport — an HTTP lane has no
  // argv to carry an effort flag and no env of its own.
  if (invoke.effortChannel !== 'none') {
    errors.push(
      ctx + ' reviewer.invoke.effortChannel must be "none" for transport "openai-http" ' +
      '(got: ' + describeValue(invoke.effortChannel) + ')',
    );
  }

  return errors;
}

// #1459 CONVERGENCE finding 1(b) — GENEROUS DoS backstop on a (possibly project-plantable) hook
// fragment file. A real fragment is a few KiB of markdown; 8 MiB is wildly more than any legitimate
// fragment. The bounded reader refuses a non-regular (FIFO/device/symlink-to-nonregular) or oversized
// fragment WITHOUT a raw blocking read, so a forged in-bundle FIFO/oversized fragment.path becomes an
// un-materializable fragment (a validation error / skip) instead of hanging or OOM-ing the loop.
const FRAGMENT_MAX_BYTES = 8 * 1024 * 1024;

function materializeHookFragments(cap, capDir) {
  const errors = [];
  const hookGroups = [
    ['steps', Array.isArray(cap.steps) ? cap.steps : []],
    ['contributions', Array.isArray(cap.contributions) ? cap.contributions : []],
  ];

  // #1459 CONVERGENCE finding 1(b): the fragment body is read via the SHARED bounded fd reader (open →
  // fstat → require regular file → size cap → read exactly size), NOT a raw fs.readFileSync(abs,'utf8')
  // which BLOCKS forever on a forged in-bundle FIFO and reads an oversized fragment unbounded into memory.
  // Required lazily so the committed plain-.cjs validator does not hard-depend on the built ledger artifact
  // at module-load time (materialize is a runtime path, reached only after build:lib). A bounded-reader
  // throw (non-regular/oversized/IO) → an un-materializable-fragment validation error, not a hang.
  let readSmallRegularFile;
  try {
    ({ readSmallRegularFile } = require('./capability-ledger.cjs'));
  } catch {
    // Defensive: if the bounded reader is unavailable, fall back to a fail-CLOSED stub so we never
    // silently revert to an unbounded raw read. A null-returning stub turns every path fragment into an
    // "could not be read" error rather than a hang (declarative-only fragments use `inline` and skip this).
    readSmallRegularFile = () => null;
  }

  for (const [groupName, hooks] of hookGroups) {
    for (let i = 0; i < hooks.length; i++) {
      const hook = hooks[i];
      if (!hook || typeof hook !== 'object' || Array.isArray(hook)) continue;
      const fragment = hook.fragment;
      if (!fragment || typeof fragment !== 'object' || Array.isArray(fragment)) continue;
      if (typeof fragment.inline === 'string') continue;
      if (typeof fragment.path !== 'string') continue;

      const abs = path.resolve(capDir, fragment.path);
      const capRoot = path.resolve(capDir);
      if (abs !== capRoot && !abs.startsWith(capRoot + path.sep)) {
        errors.push(
          cap.id + '/' + groupName + '[' + i + '].fragment.path escapes capability directory: ' +
          fragment.path,
        );
        continue;
      }

      try {
        const body = readSmallRegularFile(abs, FRAGMENT_MAX_BYTES);
        if (body === null) {
          // null = genuinely missing (ENOENT) OR refused as non-regular/oversized via the stub fallback.
          errors.push(
            cap.id + '/' + groupName + '[' + i + '].fragment.path could not be read (missing, non-regular ' +
            '(FIFO/device), or exceeds the size cap): ' + fragment.path,
          );
          continue;
        }
        fragment.inline = body;
      } catch (err) {
        // Bounded-reader fail-closed throw (non-regular/oversized/IO) — an un-materializable fragment.
        errors.push(
          cap.id + '/' + groupName + '[' + i + '].fragment.path could not be read: ' +
          fragment.path + ' (' + err.message + ')',
        );
      }
    }
  }

  return errors;
}

function validateFragment(fragment, prefix) {
  const errors = [];

  if (typeof fragment !== 'object' || fragment === null || Array.isArray(fragment)) {
    errors.push(prefix + ' must be an object with path or inline key');
    return errors;
  }

  const hasPath = Object.prototype.hasOwnProperty.call(fragment, 'path');
  const hasInline = Object.prototype.hasOwnProperty.call(fragment, 'inline');
  if (!hasPath && !hasInline) {
    errors.push(prefix + ' must have a "path" or "inline" key');
  }
  if (hasInline) {
    const inline = fragment.inline;
    if (typeof inline !== 'string') {
      errors.push(prefix + '.inline must be a string');
    } else if (inline === '') {
      errors.push(prefix + '.inline must be a non-empty string');
    }
  }
  // S1: fragment.path traversal guard — must be a relative path with no ".." segments
  if (hasPath) {
    const p = fragment.path;
    if (typeof p !== 'string' || p === '' || path.isAbsolute(p) || p.split(/[\\/]/).includes('..')) {
      errors.push(prefix + '.path must be a relative path with no ".." segments');
    }
  }

  return errors;
}

/**
 * Validate a single step entry.
 *
 * @param {object}   step            The step to validate.
 * @param {string}   prefix          Path prefix for error messages (e.g. "steps[0]").
 * @param {Set|null} declaredSkills  Set of skill stems declared in this capability's skills array,
 *                                   or null if the skills array was not valid (skip membership check).
 * @param {Set|null} declaredAgents  Set of agent names declared in this capability's agents array,
 *                                   or null if the agents array was not valid (skip membership check).
 * @returns {string[]}
 */
function validateStep(step, prefix, declaredSkills, declaredAgents) {
  const errors = [];

  if (!VALID_LOOP_POINTS.has(step.point)) {
    errors.push(prefix + '.point "' + step.point + '" is not a valid loop point');
  }

  if (typeof step.ref !== 'object' || step.ref === null) {
    errors.push(prefix + '.ref must be an object with skill, agent, or command key');
  } else {
    const hasSkill = Object.prototype.hasOwnProperty.call(step.ref, 'skill');
    const hasAgent = Object.prototype.hasOwnProperty.call(step.ref, 'agent');
    const hasCommand = Object.prototype.hasOwnProperty.call(step.ref, 'command');
    const dispatchCount = [hasSkill, hasAgent, hasCommand].filter(Boolean).length;
    if (dispatchCount === 0) {
      errors.push(prefix + '.ref must have a "skill", "agent", or "command" key');
    } else if (dispatchCount > 1) {
      // ref must be exclusive: skill XOR agent XOR command
      errors.push(prefix + '.ref must have exactly one of "skill", "agent", or "command", not multiple');
    }
    if (hasSkill && typeof step.ref.skill !== 'string') {
      errors.push(prefix + '.ref.skill must be a string');
    } else if (hasSkill && typeof step.ref.skill === 'string' && step.ref.skill.startsWith('gsd-')) {
      // Double-prefix guard: ref.skill is an unprefixed stem (e.g. "ui-review").
      // Workflow dispatch prepends "gsd-" at runtime → "gsd-ui-review".
      // A stem that already starts with "gsd-" would produce "gsd-gsd-..." at dispatch.
      errors.push(
        prefix + '.ref.skill "' + step.ref.skill + '" must not start with "gsd-" ' +
        '(it is an unprefixed stem; the workflow prepends "gsd-" at dispatch — ' +
        'starting with "gsd-" would produce "gsd-' + step.ref.skill + '")',
      );
    } else if (hasSkill && typeof step.ref.skill === 'string' && declaredSkills !== null && !declaredSkills.has(step.ref.skill)) {
      // Membership check: ref.skill must be declared in this capability's skills array.
      // This catches typos and ensures every dispatched skill is owned by this capability.
      errors.push(
        prefix + '.ref.skill "' + step.ref.skill + '" is not declared in this capability\'s skills: [' +
        [...declaredSkills].join(', ') + ']',
      );
    }
    if (hasAgent && typeof step.ref.agent !== 'string') {
      errors.push(prefix + '.ref.agent must be a string');
    } else if (hasAgent && typeof step.ref.agent === 'string' && declaredAgents !== null && !declaredAgents.has(step.ref.agent)) {
      // Membership check: ref.agent must be declared in this capability's agents array.
      errors.push(
        prefix + '.ref.agent "' + step.ref.agent + '" is not declared in this capability\'s agents: [' +
        [...declaredAgents].join(', ') + ']',
      );
    }
    if (hasCommand && typeof step.ref.command !== 'string') {
      errors.push(prefix + '.ref.command must be a string');
    }
  }

  if (!Array.isArray(step.produces)) {
    errors.push(prefix + '.produces must be an array');
  } else {
    for (const p of step.produces) {
      if (typeof p !== 'string') errors.push(prefix + '.produces entries must be strings');
    }
  }

  if (!Array.isArray(step.consumes)) {
    errors.push(prefix + '.consumes must be an array');
  } else {
    for (const c of step.consumes) {
      if (typeof c !== 'string') errors.push(prefix + '.consumes entries must be strings');
    }
  }

  if (step.when !== undefined && typeof step.when !== 'string') {
    errors.push(prefix + '.when must be a string if present');
  }

  if (step.fragment !== undefined) {
    errors.push(...validateFragment(step.fragment, prefix + '.fragment'));
  }

  if (!VALID_ON_ERROR.has(step.onError)) {
    errors.push(prefix + '.onError must be "skip" or "halt" (got: ' + step.onError + ')');
  }

  return errors;
}

function validateContribution(contrib, prefix) {
  const errors = [];

  if (!VALID_LOOP_POINTS.has(contrib.point)) {
    errors.push(prefix + '.point "' + contrib.point + '" is not a valid loop point');
  }

  if (typeof contrib.into !== 'string') {
    errors.push(prefix + '.into must be a string (agent role name)');
  }

  if (!Array.isArray(contrib.produces)) {
    errors.push(prefix + '.produces must be an array');
  } else {
    for (const p of contrib.produces) {
      if (typeof p !== 'string') errors.push(prefix + '.produces entries must be strings');
    }
  }

  if (!Array.isArray(contrib.consumes)) {
    errors.push(prefix + '.consumes must be an array');
  } else {
    for (const c of contrib.consumes) {
      if (typeof c !== 'string') errors.push(prefix + '.consumes entries must be strings');
    }
  }

  errors.push(...validateFragment(contrib.fragment, prefix + '.fragment'));

  if (contrib.when !== undefined && typeof contrib.when !== 'string') {
    errors.push(prefix + '.when must be a string if present');
  }

  if (contrib.onError !== undefined && !VALID_ON_ERROR.has(contrib.onError)) {
    errors.push(prefix + '.onError must be "skip" or "halt" if present');
  }

  return errors;
}

function validateGate(gate, prefix) {
  const errors = [];

  if (!VALID_LOOP_POINTS.has(gate.point)) {
    errors.push(prefix + '.point "' + gate.point + '" is not a valid loop point');
  }

  if (typeof gate.check !== 'object' || gate.check === null) {
    errors.push(prefix + '.check must be an object');
  } else {
    const hasQuery = Object.prototype.hasOwnProperty.call(gate.check, 'query');
    const hasPredicate = Object.prototype.hasOwnProperty.call(gate.check, 'predicate');
    const hasAgentVerdict = Object.prototype.hasOwnProperty.call(gate.check, 'agentVerdict');
    const count = [hasQuery, hasPredicate, hasAgentVerdict].filter(Boolean).length;
    if (count !== 1) {
      errors.push(prefix + '.check must have exactly one of: query, predicate, agentVerdict');
    }
    // agentVerdict forces blocking: false (advisory only)
    if (hasAgentVerdict && gate.blocking === true) {
      errors.push(
        prefix + '.check.agentVerdict forces blocking: false (non-deterministic checks may not halt the loop)',
      );
    }
  }

  if (gate.when !== undefined && typeof gate.when !== 'string') {
    errors.push(prefix + '.when must be a string if present');
  }

  if (typeof gate.blocking !== 'boolean') {
    errors.push(prefix + '.blocking must be a boolean');
  }

  if (!VALID_ON_ERROR.has(gate.onError)) {
    errors.push(prefix + '.onError must be "skip" or "halt" (got: ' + gate.onError + ')');
  }

  return errors;
}

// ─── Contract validation ──────────────────────────────────────────────────────

/**
 * Validate per-capability contract constraints against the Loop Host Contract.
 * This covers:
 *   - contribution.into ∈ step's agentRoles
 *   - when references a config key in cap.config
 *
 * NOTE: step.consumes satisfiability is NOT checked here — it requires the full
 * set of validated capabilities (cross-capability produces). It runs in
 * validateConsumesGlobal() after loadAndValidate builds capMap.
 *
 * @param {object} cap         Validated capability object
 * @param {string} capId       Capability id (for error messages)
 */
function validateAgainstContract(cap, capId) {
  if (cap.role !== 'feature') return [];
  const errors = [];
  const prefix = 'capability "' + capId + '"';

  // contribution.into must be in the step's agentRoles
  for (const contrib of cap.contributions) {
    if (!VALID_LOOP_POINTS.has(contrib.point)) continue; // already reported
    const contract = POINT_TO_CONTRACT.get(contrib.point);
    if (contract && !contract.agentRoles.includes(contrib.into)) {
      errors.push(
        prefix + ' contribution.into "' + contrib.into + '" at point "' + contrib.point +
        '" is not in the step\'s agentRoles [' + contract.agentRoles.join(', ') + ']',
      );
    }
  }

  // when references a plausibly-valid config key (string — we require it's in cap.config)
  for (const step of cap.steps) {
    if (step.when !== undefined) {
      if (typeof step.when !== 'string') continue; // already reported above
      if (
        typeof cap.config === 'object' &&
        cap.config !== null &&
        !Object.prototype.hasOwnProperty.call(cap.config, step.when)
      ) {
        errors.push(
          prefix + ' step.when "' + step.when + '" is not defined in capability config keys',
        );
      }
    }
  }

  for (const contrib of cap.contributions) {
    if (contrib.when !== undefined) {
      if (typeof contrib.when !== 'string') continue;
      if (
        typeof cap.config === 'object' &&
        cap.config !== null &&
        !Object.prototype.hasOwnProperty.call(cap.config, contrib.when)
      ) {
        errors.push(
          prefix + ' contribution.when "' + contrib.when + '" is not defined in capability config keys',
        );
      }
    }
  }

  for (const gate of cap.gates) {
    if (gate.when !== undefined) {
      if (typeof gate.when !== 'string') continue;
      if (
        typeof cap.config === 'object' &&
        cap.config !== null &&
        !Object.prototype.hasOwnProperty.call(cap.config, gate.when)
      ) {
        errors.push(
          prefix + ' gate.when "' + gate.when + '" is not defined in capability config keys',
        );
      }
    }
  }

  return errors;
}

/**
 * C1+C2: Global consumes-satisfiability validation.
 *
 * A hook at point P consuming artifact A is satisfiable iff:
 *   - A is a host-produced artifact available from its step's :post point (C1), and
 *     that :post point's POINT_ORDER index ≤ P's index; OR
 *   - A is produced by any capability hook step at a point whose POINT_ORDER index ≤ P's index
 *     (same-point is OK — topoSortSteps enforces intra-point order); OR
 *   - A is never produced anywhere → rejected.
 *
 * Runs after capMap is fully built so cross-capability produces are visible.
 *
 * @param {Map<string, object>} capMap  Fully-validated capability map.
 * @returns {string[]}                  Array of error strings.
 */
function validateConsumesGlobal(capMap) {
  const errors = [];

  // Build producedAtPoint: artifact → earliest POINT_ORDER index at which it is produced.
  // Seed with host artifacts (C1: available from their step's :post point).
  // Host-artifact entries are tagged {pointIdx, isHost:true} so they are never excluded by
  // the self-consume check.
  const producedAtPoint = Object.create(null);
  for (const [artifact, postIdx] of Object.entries(HOST_ARTIFACT_EARLIEST_POINT_IDX)) {
    if (artifact === '__proto__' || artifact === 'constructor' || artifact === 'prototype') continue;
    producedAtPoint[artifact] = postIdx;
  }

  // Build a richer per-artifact producer list for the self-consume check.
  // Each entry: { pointIdx, capId, stepIdx } — identifies which cap+step produced the artifact.
  // Host artifacts are seeded separately (no capId) and always satisfy the consume check.
  // capHookProducers[artifact] = [{pointIdx, capId, stepIdx}, ...]
  const capHookProducers = Object.create(null);

  // Add hook-produced artifacts from all capabilities.
  for (const [capId, cap] of capMap) {
    if (cap.role !== 'feature') continue;
    for (let si = 0; si < (cap.steps || []).length; si++) {
      const step = cap.steps[si];
      if (!VALID_LOOP_POINTS.has(step.point)) continue;
      const pointIdx = POINT_ORDER.indexOf(step.point);
      for (const artifact of (step.produces || [])) {
        if (typeof artifact !== 'string') continue;
        if (artifact === '__proto__' || artifact === 'constructor' || artifact === 'prototype') continue;
        if (producedAtPoint[artifact] === undefined || pointIdx < producedAtPoint[artifact]) {
          producedAtPoint[artifact] = pointIdx;
        }
        if (!capHookProducers[artifact]) capHookProducers[artifact] = [];
        capHookProducers[artifact].push({ pointIdx, capId, stepIdx: si });
      }
    }
  }

  // Duplicate-producer invariant: two capability steps may not produce the same artifact
  // at the same Loop Extension Point. Same-point dual production makes data-flow resolution
  // ambiguous and is rejected at gen time (Decision #6).
  for (const artifact of Object.keys(capHookProducers)) {
    if (artifact === '__proto__' || artifact === 'constructor' || artifact === 'prototype') continue;
    const producers = capHookProducers[artifact];
    // Group by pointIdx
    const byPoint = Object.create(null);
    for (const entry of producers) {
      if (!byPoint[entry.pointIdx]) byPoint[entry.pointIdx] = [];
      byPoint[entry.pointIdx].push(entry);
    }
    for (const pointIdxStr of Object.keys(byPoint)) {
      const group = byPoint[pointIdxStr];
      // Count distinct (capId, stepIdx) producer steps — a single step listing the same
      // artifact twice in its produces array pushes duplicate entries but represents only
      // ONE producer step and must not false-positive the cross-step gate.
      const distinctProducers = new Set(group.map((e) => e.capId + ' ' + e.stepIdx));
      if (distinctProducers.size >= 2) {
        const pointIdx = Number(pointIdxStr);
        const pointName = POINT_ORDER[pointIdx];
        const capIds = [...new Set(group.map((e) => e.capId))].sort().join(', ');
        throw new Error(
          'duplicate-producer invariant violated: artifact "' + artifact + '" is produced by ' +
          'two or more capability steps at the same Loop Extension Point "' + pointName + '" ' +
          '(capabilities: ' + capIds + '). ' +
          'Two capability steps producing the same artifact at the same Loop Extension Point ' +
          'makes data-flow resolution ambiguous and is rejected at gen time.',
        );
      }
    }
  }

  // Now check every hook step's consumes.
  // Self-consume rule: a step H cannot satisfy its own consumes[A] from its own produces[A].
  // A is satisfiable for H iff:
  //   (a) A is a host artifact with pointIdx <= stepPointIdx, OR
  //   (b) A is produced by a DIFFERENT cap/step at pointIdx <= stepPointIdx.
  // "Different" means capId != H.capId OR stepIdx != H.stepIdx.
  for (const [capId, cap] of capMap) {
    if (cap.role !== 'feature') continue;
    const prefix = 'capability "' + capId + '"';
    for (let si = 0; si < (cap.steps || []).length; si++) {
      const step = cap.steps[si];
      if (!VALID_LOOP_POINTS.has(step.point)) continue;
      const stepPointIdx = POINT_ORDER.indexOf(step.point);
      for (const artifact of (step.consumes || [])) {
        if (typeof artifact !== 'string') continue;

        // Check host-artifact satisfaction first (never excluded by self-consume).
        const hostIdx = HOST_ARTIFACT_EARLIEST_POINT_IDX[artifact];
        const hostSatisfied = hostIdx !== undefined && hostIdx <= stepPointIdx;
        if (hostSatisfied) continue;  // fast-path: host artifact is available

        // Check cap-hook producers, excluding this step itself.
        const producers = capHookProducers[artifact];
        if (!producers || producers.length === 0) {
          // Not a host artifact and never produced by any hook.
          errors.push(
            prefix + ' step at point "' + step.point + '" consumes "' + artifact +
            '" which is never produced by any host artifact or capability hook',
          );
          continue;
        }

        // Find any non-self producer at pointIdx <= stepPointIdx.
        const otherEarliestIdx = producers.reduce((best, p) => {
          const isSelf = p.capId === capId && p.stepIdx === si;
          if (isSelf) return best;
          return (best === undefined || p.pointIdx < best) ? p.pointIdx : best;
        }, undefined);

        if (otherEarliestIdx === undefined) {
          // Only producer is this step itself — self-consume violation.
          errors.push(
            prefix + ' step at point "' + step.point + '" consumes "' + artifact +
            '" which is only produced by this step itself (a step cannot consume its own output)',
          );
        } else if (otherEarliestIdx > stepPointIdx) {
          errors.push(
            prefix + ' step at point "' + step.point + '" consumes "' + artifact +
            '" which is only produced after this point (earliest available at POINT_ORDER index ' +
            otherEarliestIdx + ' = "' + POINT_ORDER[otherEarliestIdx] + '")',
          );
        }
        // else: satisfied by another cap/step at an earlier-or-same point — OK.
      }
    }
  }

  return errors;
}

// ─── Cross-capability invariants ──────────────────────────────────────────────

const TIER_RANK = { core: 0, standard: 1, full: 2 };

/**
 * Enforce cross-capability invariants.
 *
 * @param {Map<string, object>} capMap     id → validated capability object
 * @param {Set<string>}         centralKeys  Set of keys in the central config-schema
 * @returns {string[]}          Array of error strings; empty = all pass.
 */
function validateCrossCapability(capMap, centralKeys, centralPatterns = []) {
  const errors = [];

  // Ownership: one owner per skill stem + agent name
  const skillOwner = new Map(); // skill → capId
  const agentOwner = new Map(); // agent → capId
  const familyOwner = new Map(); // command family → capId (ADR-959)
  for (const [capId, cap] of capMap) {
    if (cap.role !== 'feature') continue;
    for (const skill of cap.skills) {
      if (skillOwner.has(skill)) {
        errors.push(
          'skill "' + skill + '" is owned by both "' + skillOwner.get(skill) + '" and "' + capId + '"',
        );
      } else {
        skillOwner.set(skill, capId);
      }
    }
    for (const agent of cap.agents) {
      if (agentOwner.has(agent)) {
        errors.push(
          'agent "' + agent + '" is owned by both "' + agentOwner.get(agent) + '" and "' + capId + '"',
        );
      } else {
        agentOwner.set(agent, capId);
      }
    }
    // ADR-959: single family ownership across the whole registry
    if (Array.isArray(cap.commands)) {
      for (const cmd of cap.commands) {
        if (typeof cmd.family !== 'string' || cmd.family.length === 0) continue; // already reported
        if (cmd.family === '__proto__' || cmd.family === 'constructor' || cmd.family === 'prototype') continue;
        if (familyOwner.has(cmd.family)) {
          errors.push(
            'command family "' + cmd.family + '" is owned by both "' + familyOwner.get(cmd.family) + '" and "' + capId + '"',
          );
        } else {
          familyOwner.set(cmd.family, capId);
        }
      }
    }
  }

  // Config key ownership: exclusive AND absent from central schema.
  //
  // ADR-2782 D1/D9: the role filter was `role !== 'feature'`, which silently
  // exempted every non-feature capability from ownership AND from the
  // central-schema collision check — the reason reviewer config keys were
  // stranded centrally. Ownership is a property of DECLARING a config slice, not
  // of being a feature, so the filter is now purely on the slice's presence.
  // Verified inert at introduction: no shipped capability declares `config` on a
  // non-feature role, so this widening changes no existing key — it stops a
  // latent silent drop and unblocks Phase 4 (#2797).
  const configKeyOwner = new Map(); // key → capId
  for (const [capId, cap] of capMap) {
    if (typeof cap.config !== 'object' || cap.config === null) continue;
    for (const key of Object.keys(cap.config)) {
      if (configKeyOwner.has(key)) {
        errors.push(
          'config key "' + key + '" is owned by both "' + configKeyOwner.get(key) + '" and "' + capId + '"',
        );
      } else {
        configKeyOwner.set(key, capId);
      }
      if (centralKeys.has(key)) {
        errors.push(
          'config key "' + key + '" is declared in capability "' + capId +
          '" AND exists in the central config-schema — migration mid-flight: ' +
          'remove from central config-schema before adding to the capability',
        );
      }
      // #2797: exact-key membership is not the whole central schema. A key may
      // also be claimed by a central DYNAMIC PATTERN, and until now that
      // collision was invisible here — `centralKeys` is built from
      // `manifest.validKeys` alone.
      //
      // Why that mattered enough to fix rather than note: `isCentralConfigKey`
      // DOES consult the patterns, and `mergeFederatedConfig` skips every key
      // for which it returns true. So a federated slice overlapping a central
      // pattern is INERT — it carries no traffic — while the build stays green.
      // Two of the four key families Phase 4 migrates (`review.models.<slug>`
      // and `review.max_prompt_tokens_per_reviewer.<slug>`) were pattern-backed,
      // so the invariant was blind to exactly the migration it exists to police.
      const collidingPattern = centralPatterns.find((p) => p.test(key));
      if (collidingPattern) {
        errors.push(
          'config key "' + key + '" is declared in capability "' + capId +
          '" AND is matched by central config-schema pattern /' + collidingPattern.source +
          '/ — the federated slice would be inert (mergeFederatedConfig skips central keys): ' +
          'remove the pattern from the central config-schema in the SAME commit',
        );
      }
    }
  }

  // ── Reviewer lane uniqueness (ADR-2782 D8) ─────────────────────────────────
  //
  // slug, every flag, and reviewsSection are each unique across the MERGED
  // first-party ∪ overlay set. reviewsSection uniqueness is not cosmetic: two
  // lanes sharing a heading silently merge their output in REVIEWS.md, producing
  // a review that appears to have consensus it does not have.
  //
  // This runs in validateCrossCapability rather than in the generator because
  // BOTH callers reach it: the build-time generator over first-party, and
  // capability-loader's loadRegistry over `acceptedMap` (first-party ∪ accepted
  // overlays) per candidate. First-party is already in the map when an overlay
  // candidate is added, so the OVERLAY is the collider that gets dropped —
  // which is exactly D8's "first-party wins", with no provenance check here.
  //
  // Reviewer INSTANCES (review.reviewer_instances.<name>, ADR-1517) resolve
  // THROUGH a lane and are not lanes; they never enter these sets.
  const laneSlugClaims = new Map();     // slug           → capId[]
  const laneFlagClaims = new Map();     // flag           → capId[]
  const laneSectionClaims = new Map();  // reviewsSection → capId[]

  // Claims are ACCUMULATED and reported after the sweep, never reported on the
  // second claimant. Reporting pairwise-on-collision looks equivalent and is not:
  // with three lanes on one key it names whichever pair happened to arrive first,
  // so the message text depends on Map insertion order — which is readdir order
  // at build time and candidate order at load time. A cross-platform CI lane
  // would then disagree with a local run about the text of the same failure.
  // Accumulating makes the output a pure function of the input set for ANY N.
  const claim = (claims, key, capId) => {
    if (typeof key !== 'string' || key.length === 0) return;
    if (isReservedName(key)) return;
    let claimants = claims.get(key);
    if (claimants === undefined) {
      claimants = [];
      claims.set(key, claimants);
    }
    if (!claimants.includes(capId)) claimants.push(capId);
  };

  for (const [capId, cap] of capMap) {
    const r = cap.reviewer;
    // A capability with no lane contributes to no uniqueness set. A MALFORMED
    // body was already reported by validateCapability — do not double-report.
    if (typeof r !== 'object' || r === null || Array.isArray(r)) continue;
    claim(laneSlugClaims, r.slug, capId);
    claim(laneSectionClaims, r.reviewsSection, capId);
    if (Array.isArray(r.flags)) {
      // Flattened across arrays: Antigravity answers to --antigravity AND --agy,
      // so uniqueness is per-flag, not per-lane.
      for (const flag of r.flags) claim(laneFlagClaims, flag, capId);
    }
  }

  // One error per colliding key naming EVERY claimant, ids sorted; the whole
  // block is sorted before it is appended, so both the messages and their order
  // are independent of how the capabilities were enumerated.
  const laneCollisions = [];
  for (const [claims, label] of [
    [laneSlugClaims, 'slug'],
    [laneFlagClaims, 'flag'],
    [laneSectionClaims, 'reviewsSection'],
  ]) {
    for (const [key, claimants] of claims) {
      if (claimants.length < 2) continue;
      laneCollisions.push(
        'reviewer ' + label + ' "' + key + '" is declared by ' +
        [...claimants].sort().map((i) => '"' + i + '"').join(' and '),
      );
    }
  }
  laneCollisions.sort();
  errors.push(...laneCollisions);

  // requires: all ids exist
  for (const [capId, cap] of capMap) {
    if (!Array.isArray(cap.requires)) continue;
    for (const req of cap.requires) {
      if (!capMap.has(req)) {
        errors.push(
          'capability "' + capId + '" requires "' + req + '" which does not exist',
        );
      }
    }
  }

  // runtimeCompat: explicit runtime ids must reference runtime capabilities.
  // The wildcard "*" means descriptor-backed runtimes are supported by default.
  const runtimeIds = new Set();
  for (const [id, cap] of capMap) {
    if (cap.role === 'runtime') runtimeIds.add(id);
  }
  for (const [capId, cap] of capMap) {
    if (cap.role !== 'feature' || typeof cap.runtimeCompat !== 'object' || cap.runtimeCompat === null) continue;
    for (const field of ['supported', 'unsupported']) {
      const entries = Array.isArray(cap.runtimeCompat[field]) ? cap.runtimeCompat[field] : [];
      for (const runtimeId of entries) {
        if (runtimeId === RUNTIME_COMPAT_WILDCARD) continue;
        if (typeof runtimeId !== 'string' || runtimeId.length === 0) continue;
        if (!runtimeIds.has(runtimeId)) {
          errors.push(
            'capability "' + capId + '" runtimeCompat.' + field +
            ' references unknown runtime "' + runtimeId + '"',
          );
        }
      }
    }
    if (cap.runtimeCompat.notes && typeof cap.runtimeCompat.notes === 'object') {
      for (const runtimeId of Object.keys(cap.runtimeCompat.notes)) {
        if (runtimeId === RUNTIME_COMPAT_WILDCARD) continue;
        if (!runtimeIds.has(runtimeId)) {
          errors.push(
            'capability "' + capId + '" runtimeCompat.notes references unknown runtime "' + runtimeId + '"',
          );
        }
      }
    }
  }

  // requires: acyclic
  const cycleErrors = detectRequiresCycles(capMap);
  errors.push(...cycleErrors);

  // requires: tier-monotone (core may not require standard/full; standard may not require full)
  for (const [capId, cap] of capMap) {
    if (!Array.isArray(cap.requires) || !VALID_TIERS.has(cap.tier)) continue;
    const myRank = TIER_RANK[cap.tier];
    for (const req of cap.requires) {
      const reqCap = capMap.get(req);
      if (!reqCap || !VALID_TIERS.has(reqCap.tier)) continue;
      const reqRank = TIER_RANK[reqCap.tier];
      if (reqRank > myRank) {
        errors.push(
          'tier-monotone violation: capability "' + capId + '" (tier: ' + cap.tier +
          ') requires "' + req + '" (tier: ' + reqCap.tier +
          ') — a capability may not require a higher-tier capability',
        );
      }
    }
  }

  return errors;
}

/**
 * Detect cycles in the requires graph using DFS.
 */
function detectRequiresCycles(capMap) {
  const errors = [];
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map([...capMap.keys()].map((k) => [k, WHITE]));

  function dfs(id, stack) {
    if (color.get(id) === GRAY) {
      const cycleStr = [...stack, id].join(' → ');
      errors.push('requires cycle detected: ' + cycleStr);
      return;
    }
    if (color.get(id) === BLACK) return;
    color.set(id, GRAY);
    stack.push(id);
    const cap = capMap.get(id);
    if (cap && Array.isArray(cap.requires)) {
      for (const req of cap.requires) {
        if (capMap.has(req)) dfs(req, stack);
      }
    }
    stack.pop();
    color.set(id, BLACK);
  }

  for (const id of capMap.keys()) {
    if (color.get(id) === WHITE) dfs(id, []);
  }

  return errors;
}

// ─── requiresClosure ─────────────────────────────────────────────────────────

/**
 * Compute the transitive requires closure for a capability id.
 * Returns a Set<string> of all transitively required capability ids.
 *
 * @param {string}              id
 * @param {Map<string, object>} capMap
 */
function computeRequiresClosure(id, capMap) {
  const visited = new Set();
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.shift();
    const cap = capMap.get(current);
    if (!cap || !Array.isArray(cap.requires)) continue;
    for (const req of cap.requires) {
      if (!visited.has(req)) {
        visited.add(req);
        queue.push(req);
      }
    }
  }
  return visited;
}

// ─── Topological ordering ─────────────────────────────────────────────────────

function topoSortHookEntries(entries, hookKey, hookKind) {
  if (entries.length <= 1) return entries;

  // Build adjacency: entry A must come before entry B if B consumes something A produces
  const n = entries.length;
  const inDegree = new Array(n).fill(0);
  const adj = Array.from({ length: n }, () => []);

  for (let i = 0; i < n; i++) {
    const producesI = new Set(entries[i][hookKey].produces || []);
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const consumesJ = entries[j][hookKey].consumes || [];
      for (const artifact of consumesJ) {
        if (producesI.has(artifact)) {
          adj[i].push(j);
          inDegree[j]++;
          break;
        }
      }
    }
  }

  // Kahn's algorithm with stable tiebreak on capId
  const queue = [];
  for (let i = 0; i < n; i++) {
    if (inDegree[i] === 0) queue.push(i);
  }
  // Sort queue by capId for determinism
  queue.sort((a, b) => entries[a].capId.localeCompare(entries[b].capId));

  const result = [];
  while (queue.length > 0) {
    // Take the first (sorted) ready node
    const idx = queue.shift();
    result.push(entries[idx]);
    const newReady = [];
    for (const neighbor of adj[idx]) {
      inDegree[neighbor]--;
      if (inDegree[neighbor] === 0) newReady.push(neighbor);
    }
    newReady.sort((a, b) => entries[a].capId.localeCompare(entries[b].capId));
    queue.push(...newReady);
  }

  // Fix #2: if result.length < n, Kahn's could not complete — there is a produces/consumes
  // cycle. Do NOT silently fall back to declaration order; throw a clear error.
  if (result.length < n) {
    const sortedIds = entries.map((e) => e.capId).join(', ');
    throw new Error(
      'produces/consumes cycle detected in ' + hookKind + ' at point "' +
      (entries[0] && entries[0][hookKey] ? entries[0][hookKey].point : '?') +
      '" among capabilities [' + sortedIds + ']: ' +
      'a cycle in hook produces/consumes prevents deterministic ordering',
    );
  }
  return result;
}

/**
 * Topologically sort steps at a given point by produces/consumes.
 * Capability-id tiebreak for determinism.
 *
 * @param {{ capId: string, step: object }[]} entries
 * @returns {{ capId: string, step: object }[]}
 */
function topoSortSteps(entries) {
  return topoSortHookEntries(entries, 'step', 'steps');
}

function topoSortContributions(entries) {
  return topoSortHookEntries(entries, 'contrib', 'contributions');
}

// ─── Gen-time wired guard ─────────────────────────────────────────────────────

/**
 * Validate that every hook point declared by a capability has a corresponding
 * `loop render-hooks <point>` call site in one of the host-loop workflow files.
 *
 * Only valid loop points (in VALID_LOOP_POINTS) are checked here. Invalid points
 * are already caught by validateStep/validateContribution/validateGate — do not
 * double-report.
 *
 * @param {object}   cap       Validated capability object.
 * @param {Set<string>} wiredSet  Set of points that have call sites in host workflows.
 * @returns {string[]}          Array of error strings; empty means all points are wired.
 */
function validateHooksWired(cap, wiredSet) {
  const errors = [];
  const capId = cap.id || '(unknown)';

  function checkPoint(point, groupName, idx) {
    // Only flag valid points that are unwired — invalid points are schema-validator's job.
    if (!VALID_LOOP_POINTS.has(point)) return;
    if (!wiredSet.has(point)) {
      errors.push(
        'capability "' + capId + '" ' + groupName + '[' + idx + '].point "' + point +
        '" is declared but not wired in any host-loop workflow ' +
        '(no `loop render-hooks ' + point + '` call site). ' +
        'Wire the call site in the host workflow ' +
        '(see scripts/gen-loop-host-contract.cjs STEP_WORKFLOWS) or remove the hook.',
      );
    }
  }

  for (let i = 0; i < (cap.steps || []).length; i++) {
    const hook = cap.steps[i];
    if (hook.point !== undefined) checkPoint(hook.point, 'steps', i);
  }
  for (let i = 0; i < (cap.contributions || []).length; i++) {
    const hook = cap.contributions[i];
    if (hook.point !== undefined) checkPoint(hook.point, 'contributions', i);
  }
  for (let i = 0; i < (cap.gates || []).length; i++) {
    const hook = cap.gates[i];
    if (hook.point !== undefined) checkPoint(hook.point, 'gates', i);
  }

  return errors;
}

// ─── classifyCrossErrors ──────────────────────────────────────────────────────

/**
 * Fix #3: Emit pending-migration WARNINGs for config keys that collide with the central
 * config-schema. Per ADR-894 staged cutover, a collision during the registry-only phase is
 * NOT a hard error — the capability pipeline is being established before the atomic cutover
 * PR for each feature. The registry still generates; the warning tells the maintainer which
 * keys need to be moved out of the central schema at cutover time.
 *
 * A NEW unexpected collision (a key that shouldn't be in both) is also surfaced — the
 * maintainer sees it in build output rather than it being silently swallowed.
 *
 * Reference: ADR-894 §4 "config-key ownership exclusive AND complete — presence in both =
 * collision = a mid-flight migration; finish the move."
 *
 * @param {string[]} crossErrors   Errors from validateCrossCapability (may include collision msgs)
 * @returns {{ hardErrors: string[], pendingMigrationWarnings: string[] }}
 */
function classifyCrossErrors(crossErrors) {
  const hardErrors = [];
  const pendingMigrationWarnings = [];
  const collisionRe = /config key "([^"]+)" is declared in capability "([^"]+)" AND exists in the central config-schema/;

  for (const e of crossErrors) {
    const m = collisionRe.exec(e);
    if (m) {
      // Collision = pending-migration warning, not a hard error during 3a-impl staged cutover
      pendingMigrationWarnings.push(
        '⚠ pending-migration: capability \'' + m[2] + '\' declares config key \'' + m[1] +
        '\' still present in central config-schema; finish the move at cutover',
      );
    } else {
      hardErrors.push(e);
    }
  }
  return { hardErrors, pendingMigrationWarnings };
}

// ─── ADR-857 phase 5e: configFormat ↔ installSurface parity gate ─────────────

// Map: installSurface → expected configFormat
// Derived from the pairing of capability.json descriptors (installSurface)
// and capability.json descriptors (configFormat). DEFECT.GENERATIVE-FIX: this map
// is the single parity contract between the two generated surfaces.
// NOTE: both values come from the descriptor bodies in capMap — no dependency on
// runtime-config-adapter-registry.cjs, which now requires capability-registry.cjs
// (the file this gen-script produces), and thus must not be required here.
const INSTALL_SURFACE_TO_CONFIG_FORMAT = new Map([
  ['settings-json',        'settings-json'],
  ['codex-toml',           'toml'],
  ['copilot-instructions', 'markdown'],
  ['cline-rules',          'markdown-dir'],
  ['cursor-hooks-json',    'none'],
  ['profile-marker-only',  'none'],
  // 'none' added #2103 — a runtime with NO CLI install surface at all (e.g.
  // VS Code) has no config-file format to write either.
  ['none',                 'none'],
]);

/**
 * ADR-857 phase 5e: configFormat ↔ installSurface parity gate.
 *
 * For each runtime capability that has an installSurface in its descriptor,
 * assert that its configFormat matches the expected value derived from its
 * installSurface.  Both values are read directly from the capMap descriptor
 * bodies — no dependency on runtime-config-adapter-registry.cjs.
 *
 * HARD gate — throws on mismatch (DEFECT.GENERATIVE-FIX: this invariant is
 * derived from two parallel generated surfaces and must fail loudly).
 *
 * @param {Map<string, object>} capMap  Fully-validated capability map.
 * @returns {void}  Throws on mismatch; returns normally on success.
 */
function runConfigFormatParityGate(capMap) {
  // Read installSurface directly from the descriptor bodies already loaded into
  // capMap — eliminates the require cycle introduced when adapter-registry was
  // changed to require capability-registry.cjs (ADR-857 phase 5g drive 2).
  for (const [capId, cap] of capMap) {
    if (cap.role !== 'runtime') continue;

    const r = cap.runtime;
    if (!r || typeof r.configFormat !== 'string') continue; // already validated above

    // Only check runtimes that have an installSurface (i.e. are config-adapter runtimes)
    if (typeof r.installSurface !== 'string') continue; // grok etc. excluded — no installSurface

    const installSurface = r.installSurface;
    const expectedConfigFormat = INSTALL_SURFACE_TO_CONFIG_FORMAT.get(installSurface);

    if (expectedConfigFormat === undefined) {
      // Unknown installSurface — the mapping needs to be updated
      throw new Error(
        'configFormat parity gate: runtime "' + capId + '" has installSurface "' + installSurface +
        '" which is not in the INSTALL_SURFACE_TO_CONFIG_FORMAT mapping — ' +
        'update the mapping in scripts/gen-capability-registry.cjs',
      );
    }

    if (r.configFormat !== expectedConfigFormat) {
      throw new Error(
        'configFormat parity gate FAILED for runtime "' + capId + '":\n' +
        '  installSurface:       ' + installSurface + '\n' +
        '  expected configFormat: ' + expectedConfigFormat + '\n' +
        '  actual configFormat:   ' + r.configFormat + '\n' +
        'The capability.json configFormat must match the value derived from installSurface ' +
        '(src: scripts/gen-capability-registry.cjs INSTALL_SURFACE_TO_CONFIG_FORMAT)',
      );
    }
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Constants
  SCHEMA_VERSION,
  POINT_ORDER,
  HOST_ARTIFACT_EARLIEST_POINT_IDX,
  VALID_LOOP_POINTS,
  POINT_TO_CONTRACT,
  VALID_CONFIG_SLICE_TYPES,
  KEBAB_RE,
  VALID_ROLES,
  VALID_TIERS,
  VALID_ON_ERROR,
  RUNTIME_COMPAT_WILDCARD,
  SEMVER_RE,
  SEMVER_RANGE_RE,
  SHA512_INTEGRITY_RE,
  VALID_CONVERTER_NAMES,
  VALID_CONFIG_FORMATS,
  VALID_CONFIG_HOME_KINDS,
  VALID_COMMAND_STYLES,
  VALID_HOOKS_SURFACES,
  VALID_HOOK_EVENTS,
  VALID_EXTENSION_EVENTS,
  VALID_SANDBOX_TIERS,
  VALID_ARTIFACT_KIND_NAMES,
  VALID_ARTIFACT_NESTINGS,
  FEATURE_FIELDS_FORBIDDEN_ON_RUNTIME,
  // ADR-2782 D1/D2/D3/D6/D7/D8 — reviewer lane body
  FEATURE_FIELDS_FORBIDDEN_ON_REVIEWER,
  LANE_SLUG_RE,
  LANE_FLAG_RE,
  VALID_LANE_TRANSPORTS,
  VALID_LANE_PROBE_KINDS,
  VALID_PROMPT_CHANNELS,
  VALID_OUTPUT_CHANNELS,
  VALID_LANE_EFFORT_CHANNELS,
  VALID_MODEL_DISCOVERY,
  VALID_EMPTY_OUTPUT,
  VALID_EVIDENCE_CLASSES,
  VALID_LANE_HANDLERS,
  KNOWN_REVIEWER_FIELDS,
  validateReviewerBody,
  collectReviewerWarnings,
  VALID_INSTALL_SURFACES,
  VALID_PERMISSION_WRITERS,
  VALID_EXTENDED_HOOK_EVENTS,
  VALID_EMBEDDING_MODES,
  VALID_COMMAND_SURFACES,
  VALID_MODEL_MODES,
  VALID_HOOK_BUSES,
  VALID_STATE_IO,
  VALID_TRANSPORTS,
  VALID_HOST_RUNTIMES,
  VALID_SUBAGENT_TOOLKITS,
  VALID_DISPATCH_ISOLATION,
  _HOST_INTEGRATION_VOCAB: {
    embeddingMode:   [...VALID_EMBEDDING_MODES],
    commandSurface:  [...VALID_COMMAND_SURFACES],
    modelMode:       [...VALID_MODEL_MODES],
    hookBus:         [...VALID_HOOK_BUSES],
    stateIO:         [...VALID_STATE_IO],
    transport:       [...VALID_TRANSPORTS],
    runtime:         [...VALID_HOST_RUNTIMES],
    subagentToolkit: [...VALID_SUBAGENT_TOOLKITS],
    effortSurface:   [...VALID_EFFORT_SURFACES],
    isolation:       [...VALID_DISPATCH_ISOLATION],
  },
  INSTALL_SURFACE_TO_ALLOWED_HOOKS_SURFACES,
  GEMINI_AGENT_EVENTS,
  CLAUDE_FAMILY_EVENTS,
  TIER_RANK,
  INSTALL_SURFACE_TO_CONFIG_FORMAT,
  // Functions
  isPlausibleRange,
  validateVersionEnvelope,
  validateCapability,
  validateCommandEntry,
  validateRuntimeCompat,
  validateFeatureBody,
  validateConfigHome,
  validateArtifactKindEntry,
  validateArtifactLayout,
  validateRuntimeBody,
  materializeHookFragments,
  validateFragment,
  validateStep,
  validateContribution,
  validateGate,
  validateAgainstContract,
  validateConsumesGlobal,
  validateCrossCapability,
  detectRequiresCycles,
  computeRequiresClosure,
  topoSortHookEntries,
  topoSortSteps,
  topoSortContributions,
  validateHooksWired,
  validateConfigSliceEntry,
  classifyCrossErrors,
  runConfigFormatParityGate,
};
