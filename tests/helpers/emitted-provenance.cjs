'use strict';

/**
 * Emitted-artifact provenance table + totality guard (ADR-2719 §2, issue #2722).
 *
 * Maps every EMITTED path (a key in any tests/fixtures/golden-install-parity/*.json
 * manifest) to the REPO SOURCE path(s) whose change can legitimately explain a
 * change to it. Phase 3 (#2723) consumes this to turn "these emitted hashes moved"
 * into "…and nothing in this diff explains them".
 *
 * This module resolves provenance ONLY. It never reads a git diff, never builds a
 * manifest, and never re-derives a byte — ADR-2719 §1 is explicit that this design
 * constrains which keys may move, rather than asserting emitted == transform(source)
 * (the tautology ADR-2264's Amendment rejected).
 *
 * ── Totality ────────────────────────────────────────────────────────────────
 * Every emitted path must match EXACTLY ONE rule. Zero matches, two matches, and
 * a rule that matches nothing are all hard failures. A hand-maintained table's
 * characteristic risk is rotting into a silent gap; totality converts that into a
 * loud one, so a new emitted family fails the build instead of passing through
 * unattributed.
 *
 * ── Derived vs. hard-coded (deliberate split) ───────────────────────────────
 * Emitted SHAPES (roots + patterns) are hard-coded on purpose. The guard's whole
 * value is failing when the installer starts emitting something new; a table that
 * derived its shapes from the installer could never fail that way — it would follow
 * the installer anywhere, silently, which is the tautology above rebuilt.
 * Source PATHS may read a first-party descriptor when the descriptor is the only
 * declaration of that source (`hostBehaviors.nativePlugin.source`). The emitted dest
 * stays hard-coded, so a dest change still fails loud.
 *
 * ── The trap this table exists to avoid ─────────────────────────────────────
 * The repo contains `skills/gsd-<stem>/SKILL.md` (71 dirs) that LOOK like the source
 * of the emitted `skills/` family. They are not: scripts/gen-plugin-skills.cjs
 * GENERATES them from commands/gsd/*.md, and the installer stages from commands/gsd/
 * directly (src/install-profiles.cts:637-708). Attributing emitted skills to repo
 * skills/ would be false attribution that still passes totality — the exact residual
 * risk ADR-2719 records. The spot-check tests pin this pair.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'golden-install-parity');

/** Number of runtime manifests the guard expects to cover. Asserted, so a glob that
 *  silently matches fewer files can never report a vacuous pass. */
const EXPECTED_MANIFEST_COUNT = 19;

// ─── Emitted roots ────────────────────────────────────────────────────────────
// Longest-first: `skills/gsd` (hermes category dir) must win over `skills` for
// `skills/gsd/...`, and `.agents/skills` must win over `.agents`.

const SKILLS_ROOTS = ['skills/gsd', '.agents/skills', 'skills'];
const HOOKS_ROOTS = ['.kimi/hooks', 'hooks'];

/** Source-of-truth command dir every skill/command surface converts from. */
const COMMANDS_SRC = 'commands/gsd';

/** Installer source file that emits the Cline/AGENTS.md instruction bodies as
 *  code literals (buildClineRulesBody / buildClineAgentsMdBody /
 *  buildClinePreToolUseHook). */
const CLINE_BODY_SRC = 'src/runtime-hooks-surface.cts';

/** Installer source file that emits the Hermes skill-category DESCRIPTION.md
 *  (writeHermesCategoryDescription) as a code literal. */
const INSTALLER_SRC = 'bin/install.js';

/** Source file holding the Kimi root-agent literal (runtime-artifact-layout.cts:303). */
const KIMI_ROOT_AGENT_SRC = 'src/runtime-artifact-layout.cts';

/**
 * A `sources` entry ending in `/` is a PREFIX, not a file: it means "any repo path
 * under this directory legitimately explains this emitted path". Used where an
 * emitted artifact aggregates a whole directory (Kimi's root agent enumerates every
 * staged agent). Phase 3 must honor the trailing slash when testing a changed-path
 * set against these sources; a plain string is an exact path.
 */
const SOURCE_PREFIX_SUFFIX = '/';

/**
 * Strip the runtime skill prefix from a staged skill directory name.
 * Router/flat skill dirs are `<prefix><stem>`; nested CHILD dirs are the bare
 * stem (src/install-profiles.cts:696 joins `stem`, not `prefix + stem`).
 */
function stripSkillPrefix(dirName) {
  return dirName.startsWith('gsd-') ? dirName.slice(4) : dirName;
}

/**
 * Resolve a runtime's declared native plugin/extension source from the compiled
 * capability registry — the only place that mapping is declared.
 * Returns null when the runtime declares none.
 */
function nativePluginDescriptor(runtime) {
  // Required lazily so a missing build surfaces at call time with a clear message
  // rather than at module load for callers that never touch this family.
  let registry;
  try {
    registry = require('../../gsd-core/bin/lib/capability-registry.cjs');
  } catch (err) {
    throw new Error(
      'emitted-provenance: cannot load gsd-core/bin/lib/capability-registry.cjs ' +
      `(run \`npm run build\` first): ${err.message}`,
    );
  }
  const entry = registry
    && registry.runtimes
    && registry.runtimes[runtime]
    && registry.runtimes[runtime].runtime
    && registry.runtimes[runtime].runtime.hostBehaviors;
  return (entry && entry.nativePlugin) || null;
}

// ─── The table ────────────────────────────────────────────────────────────────
//
// kind:
//   identity     — emitted path IS the repo path
//   rewrite      — emitted path maps to a differently-named repo path
//   derived      — emitted file is generated from another repo file
//   descriptor   — source declared by a first-party runtime descriptor
//   code-derived — content is a literal inside a repo source file (attributable)
//   synthesized  — install-time/environment state, no repo content source (EXEMPT)
//
// `roots`   — emitted prefixes this rule applies under (null = match `rel` whole)
// `pattern` — matched against the root-stripped tail (or whole `rel` when roots is null)
// `sources` — (match, ctx) => string[] of repo-relative paths; [] only for `synthesized`
//
// Rule ORDER CARRIES NO SEMANTICS. Exactly-one matching is enforced, so rules are
// mutually exclusive by construction and the table reads correctly in any order.

const PROVENANCE_RULES = [
  // ── Verbatim engine payload ────────────────────────────────────────────────
  {
    id: 'gsd-core-verbatim',
    kind: 'identity',
    roots: ['gsd-core'],
    // Enumerated subdirs, NOT `.+`: a new gsd-core/<subdir> must fail totality
    // loudly rather than being absorbed silently. Also keeps this mutually
    // exclusive with the two synthesized gsd-core top-level files below.
    pattern: /^(workflows|references|templates|contexts|bin)\/.+$/,
    sources: (m) => [`gsd-core/${m[0]}`],
  },
  {
    id: 'scripts-verbatim',
    kind: 'identity',
    roots: ['scripts'],
    pattern: /^.+$/,
    sources: (m) => [`scripts/${m[0]}`],
  },
  {
    id: 'agents-verbatim',
    kind: 'identity',
    roots: ['agents'],
    // Excludes `gsd.md`: that is Kimi's ROOT agent, built from a code literal and
    // NOT a repo agent file. Without the exclusion it matched here and resolved to
    // `agents/gsd.md`, which does not exist — a false attribution that still passed
    // totality, i.e. the exact residual ADR-2719 records. Every repo agent is
    // `gsd-<name>.md`, so excluding the bare `gsd.md` is precise.
    // `.agent.md` is likewise excluded — Copilot emits a RENAMED copy
    // (`<name>.agent.md`) whose source is `agents/<name>.md`; matching it here
    // resolved to a file that does not exist. Same false-attribution class.
    pattern: /^(?!gsd\.md$)(?!.*\.agent\.md$)[^/]+\.md$/,
    sources: (m) => [`agents/${m[0]}`],
  },
  {
    id: 'copilot-agent-rename',
    kind: 'rewrite',
    roots: ['agents'],
    pattern: /^([^/]+)\.agent\.md$/,
    sources: (m) => [`agents/${m[1]}.md`],
  },

  // ── Derived from another repo file ─────────────────────────────────────────
  {
    id: 'agents-toml-derived',
    kind: 'derived',
    roots: ['agents'],
    // Codex emits a .toml agent descriptor alongside/instead of the .md, generated
    // from the same agents/<name>.md source.
    pattern: /^([^/]+)\.toml$/,
    sources: (m) => [`agents/${m[1]}.md`],
  },
  {
    id: 'agents-subagent-derived',
    kind: 'derived',
    roots: ['agents'],
    // Kimi emits a per-agent subagent pair (.md + .yaml) from one agents/*.md.
    // install.js:2344 — `yamlPath: agents/subagents/${subagent.name}.yaml`.
    pattern: /^subagents\/([^/]+)\.(md|yaml)$/,
    sources: (m) => [`agents/${m[1]}.md`],
  },
  {
    id: 'hooks-built',
    kind: 'derived',
    roots: HOOKS_ROOTS,
    // Emitted from hooks/dist/, which scripts/build-hooks.js builds from hooks/.
    // Attribute to the REPO source a PR actually edits, not the build artifact.
    // Excludes Copilot's hook-registration JSON (next rule) — that is a code
    // literal, not a built script, and attributing it here resolved to a
    // nonexistent `hooks/gsd-session.json`.
    pattern: /^(?!gsd-session\.json$).+$/,
    sources: (m) => [`hooks/${m[0]}`],
  },
  {
    id: 'copilot-hook-registration',
    kind: 'code-derived',
    roots: ['hooks'],
    // Deliberately golden-trackable: unlike settings.json / hooks.json (excluded
    // by HOOK_CONFIG_FILES because they embed a platform-varying node-runner
    // command), this one is platform-stable and stays in the manifest
    // (src/runtime-hooks-surface.cts:73,89).
    pattern: /^gsd-session\.json$/,
    sources: () => [CLINE_BODY_SRC],
  },

  // ── Skill / command surfaces — all convert from commands/gsd/*.md ──────────
  {
    id: 'skills-from-commands',
    kind: 'rewrite',
    roots: SKILLS_ROOTS,
    pattern: /^([^/]+)\/SKILL\.md$/,
    sources: (m) => [`${COMMANDS_SRC}/${stripSkillPrefix(m[1])}.md`],
  },
  {
    id: 'skills-nested-from-commands',
    kind: 'rewrite',
    roots: SKILLS_ROOTS,
    // #69 namespace nesting: a concrete skill routed by an ns-* router is copied
    // under `<prefix><router>/skills/<childStem>/SKILL.md`. The CHILD stem is the
    // source — attributing to the router would be wrong for every nested skill.
    pattern: /^([^/]+)\/skills\/([^/]+)\/SKILL\.md$/,
    sources: (m) => [`${COMMANDS_SRC}/${stripSkillPrefix(m[2])}.md`],
  },
  {
    id: 'flat-commands-from-commands',
    kind: 'rewrite',
    roots: ['commands', 'command'],
    pattern: /^gsd-([^/]+)\.md$/,
    sources: (m) => [`${COMMANDS_SRC}/${m[1]}.md`],
  },

  // ── Descriptor-declared native plugin / extension ─────────────────────────
  {
    id: 'native-plugin',
    kind: 'descriptor',
    roots: ['plugins', 'extensions'],
    pattern: /^[^/]+\.(js|cjs|mjs)$/,
    // Source is per-runtime (opencode -> .opencode/…, kilo -> .kilo/…,
    // pi -> pi/gsd.cjs), so attribution is a function of (rel, runtime).
    sources: (m, ctx) => {
      const np = nativePluginDescriptor(ctx.runtime);
      if (!np || !np.source) {
        throw new Error(
          `emitted-provenance: runtime "${ctx.runtime}" emits ${ctx.rel} but declares ` +
          'no hostBehaviors.nativePlugin.source in the capability registry',
        );
      }
      return [np.source];
    },
  },

  // ── Code-derived: content is a literal in a repo source file ──────────────
  // Attributable on purpose. Marking these exempt would make them permanently
  // blind — they could change forever without ever raising an alarm.
  {
    id: 'cline-rules-code-derived',
    kind: 'code-derived',
    roots: ['.clinerules'],
    pattern: /^(gsd\.md|hooks\/PreToolUse)$/,
    sources: () => [CLINE_BODY_SRC],
  },
  {
    id: 'agents-md-code-derived',
    kind: 'code-derived',
    roots: ['.agents'],
    pattern: /^AGENTS\.md$/,
    sources: () => [CLINE_BODY_SRC],
  },
  {
    id: 'hermes-category-description',
    kind: 'code-derived',
    roots: ['skills/gsd'],
    pattern: /^DESCRIPTION\.md$/,
    sources: () => [INSTALLER_SRC],
  },
  {
    id: 'kimi-root-agent',
    kind: 'code-derived',
    roots: ['agents'],
    // Kimi's root agent pair. The YAML/prompt bodies come from a code literal
    // (src/runtime-artifact-layout.cts:303), and the YAML additionally enumerates
    // every staged subagent — so adding or removing an agents/*.md legitimately
    // moves this file too. Both sources are declared.
    pattern: /^gsd\.(yaml|md)$/,
    sources: () => [KIMI_ROOT_AGENT_SRC, 'agents/'],
  },

  // ── Synthesized: install-time / environment state, no repo content source ──
  {
    id: 'synthesized-install-metadata',
    kind: 'synthesized',
    roots: null,
    // `.kimi/package.json` is the same literal `{"type":"commonjs"}` CommonJS-mode
    // marker as the root one, written into Kimi's separate hooks root
    // (installSharedHooksBundle, install.js:11044-11046).
    pattern: /^(\.gsd-profile|package\.json|\.kimi\/package\.json|gsd-core\/VERSION|gsd-core\/\.gsd-runtime)$/,
    sources: () => [],
  },
  {
    id: 'synthesized-gsd-defaults',
    kind: 'synthesized',
    roots: null,
    pattern: /^\.gsd\/defaults\.json$/,
    sources: () => [],
  },
  {
    id: 'synthesized-host-config',
    kind: 'synthesized',
    roots: null,
    pattern: /^(opencode\.json|kilo\.json|mcp_config\.json|config\.toml|copilot-instructions\.md)$/,
    sources: () => [],
  },
];

// ─── Matching ─────────────────────────────────────────────────────────────────

/**
 * Reject an emitted key that could escape the repo once turned into a source path.
 *
 * Two rules (`gsd-core-verbatim`, `scripts-verbatim`) capture a whole tail with
 * `.+` rather than `[^/]+`, so a key like `gsd-core/workflows/../../../etc/passwd`
 * would otherwise produce a source path that `path.join(REPO_ROOT, src)` resolves
 * OUTSIDE the repo. Nothing reachable today exploits it — real manifest keys come
 * from installer output and the only consumer is an `fs.existsSync` probe — but
 * Phase 3 (#2723) feeds these strings into a diff-consuming check, and a `..`
 * segment is never legitimate in an emitted manifest key. Fail closed here, once,
 * rather than per-rule.
 */
function assertSafeRelPath(rel) {
  if (typeof rel !== 'string' || rel === '') {
    throw new Error(`emitted-provenance: emitted path must be a non-empty string, got ${typeof rel}`);
  }
  if (path.posix.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) {
    throw new Error(`emitted-provenance: emitted path must be relative, got "${rel}"`);
  }
  if (rel.split('/').includes('..')) {
    throw new Error(
      `emitted-provenance: emitted path "${rel}" contains a ".." segment — ` +
      'manifest keys are installer output and must never traverse.',
    );
  }
  if (rel.includes('\0')) {
    throw new Error(`emitted-provenance: emitted path "${rel}" contains a NUL byte`);
  }
}

/**
 * Try one rule against one emitted path.
 * @returns {RegExpMatchArray|null} the regex match, or null when the rule does not apply.
 */
function matchOne(rule, rel) {
  if (rule.roots === null) {
    return rel.match(rule.pattern);
  }
  for (const root of rule.roots) {
    if (!rel.startsWith(`${root}/`)) continue;
    const tail = rel.slice(root.length + 1);
    const m = tail.match(rule.pattern);
    if (m) return m;
  }
  return null;
}

/**
 * All rules matching an emitted path. The guard requires exactly one; returning
 * the full list (rather than first-match-wins) is what makes ambiguity reportable
 * instead of silently resolved by rule order.
 *
 * @param {string} rel     POSIX emitted manifest key
 * @param {string} runtime runtime id (attribution is per-(rel, runtime) — one emitted
 *                         path can have different sources on different hosts)
 * @param {Array}  rules   rule table. Injectable so tests can drive the REAL matching
 *                         path with a corrupted/reordered/pruned table. Without this
 *                         seam a test can only re-implement matching by hand, which
 *                         proves nothing about the shipped code path.
 * @returns {Array<{rule: object, match: RegExpMatchArray}>}
 */
function matchRules(rel, runtime, rules = PROVENANCE_RULES) {
  assertSafeRelPath(rel);
  const hits = [];
  for (const rule of rules) {
    if (rule.runtimes && !rule.runtimes.has(runtime)) continue;
    const m = matchOne(rule, rel);
    if (m) hits.push({ rule, match: m });
  }
  return hits;
}

/**
 * Resolve the provenance of one emitted path.
 * @throws when the path matches zero or more than one rule.
 * @returns {{ruleId: string, kind: string, sources: string[]}}
 */
function attributeEmittedPath(rel, runtime, rules = PROVENANCE_RULES) {
  const hits = matchRules(rel, runtime, rules);
  if (hits.length === 0) {
    throw new Error(
      `emitted-provenance: no rule matches "${rel}" (runtime "${runtime}"). ` +
      'Add a rule, or the installer is emitting an unattributed family.',
    );
  }
  if (hits.length > 1) {
    throw new Error(
      `emitted-provenance: "${rel}" (runtime "${runtime}") matches ${hits.length} rules ` +
      `[${hits.map((h) => h.rule.id).join(', ')}] — rules must be mutually exclusive.`,
    );
  }
  const { rule, match } = hits[0];
  return {
    ruleId: rule.id,
    kind: rule.kind,
    sources: rule.sources(match, { rel, runtime }),
  };
}

// ─── Fixture loading ──────────────────────────────────────────────────────────

/**
 * Load every committed golden-parity manifest as {runtime, rel, keys}.
 * Rejects a manifest whose JSON parses but is not a plain object — treating `0`,
 * `"s"`, `[]`, `null` or `true` as "no keys" would let the whole guard pass
 * vacuously on a corrupt fixture.
 */
function loadManifests(fixturesDir = FIXTURES_DIR) {
  const files = fs.readdirSync(fixturesDir).filter((f) => f.endsWith('.json')).sort();
  return files.map((file) => {
    const full = path.join(fixturesDir, file);
    const raw = fs.readFileSync(full, 'utf8');
    if (raw.trim() === '') {
      throw new Error(`emitted-provenance: fixture ${file} is empty`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`emitted-provenance: fixture ${file} is not valid JSON: ${err.message}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(
        `emitted-provenance: fixture ${file} must be a JSON object of path->hash, ` +
        `got ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
      );
    }
    return {
      file,
      // `claude-local.json` is the claude runtime at local scope; the descriptor
      // lookup keys on the runtime id, not the fixture name.
      runtime: file.replace(/\.json$/, '').replace(/-local$/, ''),
      keys: Object.keys(parsed),
    };
  });
}

// ─── Totality guard ───────────────────────────────────────────────────────────

/**
 * Assert the table is TOTAL over every emitted path in every manifest.
 *
 * Three distinct failures, reported together so one run tells the whole story:
 *   unmatched — an emitted path no rule claims (the installer grew a family)
 *   ambiguous — an emitted path two rules claim (the table has overlapping rules)
 *   dead      — a rule nothing matches (the table has rotted relative to reality)
 *
 * @param {Array} manifests    from loadManifests()
 * @param {Array} rules        rule table (injectable so tests can remove/corrupt one)
 * @param {number} sampleLimit max named paths per bucket in the message
 * @returns {{checked: number, byRule: Map<string, number>}}
 */
function assertTotality(manifests, rules = PROVENANCE_RULES, sampleLimit = 10) {
  const unmatched = [];
  const ambiguous = [];
  const byRule = new Map(rules.map((r) => [r.id, 0]));
  let checked = 0;

  for (const { runtime, file, keys } of manifests) {
    for (const rel of keys) {
      checked++;
      // Reuse matchRules rather than re-implementing the loop: two copies of the
      // matching semantics is the divergence class this repo has been bitten by
      // before (#2266), and it would let the guard and the attributor disagree.
      const hits = matchRules(rel, runtime, rules).map((h) => h.rule.id);
      if (hits.length === 0) {
        unmatched.push(`${file}: ${rel}`);
      } else if (hits.length > 1) {
        ambiguous.push(`${file}: ${rel} -> [${hits.join(', ')}]`);
      } else {
        byRule.set(hits[0], byRule.get(hits[0]) + 1);
      }
    }
  }

  const dead = [...byRule.entries()].filter(([, n]) => n === 0).map(([id]) => id);

  if (unmatched.length || ambiguous.length || dead.length) {
    const parts = [];
    if (unmatched.length) {
      parts.push(
        `${unmatched.length} emitted path(s) match no provenance rule:\n  ` +
        unmatched.slice(0, sampleLimit).join('\n  ') +
        (unmatched.length > sampleLimit ? `\n  …and ${unmatched.length - sampleLimit} more` : ''),
      );
    }
    if (ambiguous.length) {
      parts.push(
        `${ambiguous.length} emitted path(s) match more than one rule:\n  ` +
        ambiguous.slice(0, sampleLimit).join('\n  ') +
        (ambiguous.length > sampleLimit ? `\n  …and ${ambiguous.length - sampleLimit} more` : ''),
      );
    }
    if (dead.length) {
      parts.push(
        `${dead.length} rule(s) match nothing (table has drifted): ${dead.join(', ')}`,
      );
    }
    throw new Error(`emitted-provenance totality failed.\n\n${parts.join('\n\n')}`);
  }

  return { checked, byRule };
}

module.exports = {
  EXPECTED_MANIFEST_COUNT,
  FIXTURES_DIR,
  PROVENANCE_RULES,
  SKILLS_ROOTS,
  KIMI_ROOT_AGENT_SRC,
  SOURCE_PREFIX_SUFFIX,
  HOOKS_ROOTS,
  COMMANDS_SRC,
  CLINE_BODY_SRC,
  INSTALLER_SRC,
  stripSkillPrefix,
  nativePluginDescriptor,
  matchOne,
  assertSafeRelPath,
  matchRules,
  attributeEmittedPath,
  loadManifests,
  assertTotality,
};
