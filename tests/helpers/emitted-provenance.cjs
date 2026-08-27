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

const path = require('node:path');

const { cleanup } = require('../helpers.cjs');
const { MANIFEST_FAMILIES, runMinimalInstall, buildParityManifest } = require('./install-shared.cjs');

/**
 * Number of runtime manifests the guard expects to cover. Asserted, so a glob that
 * silently matches fewer files can never report a vacuous pass.
 *
 * DERIVED, not a literal (#2723). It was `19`, and that same literal was also asserted
 * against the baseline built at the base ref — two trees that legitimately differ by one
 * family whenever a PR adds or removes a runtime, which made every such PR unpassable at
 * any value. Deriving it from the single `MANIFEST_FAMILIES` source keeps the
 * anti-vacuity property here (this tree's glob must match this tree's registry) while
 * leaving the cross-tree question to `reconcileFamilies`, which is set-based and
 * direction-aware. The absolute floor that a shrunken universe cannot satisfy lives with
 * the derivation as `MINIMUM_MANIFEST_FAMILIES`.
 */
const EXPECTED_MANIFEST_COUNT = MANIFEST_FAMILIES.length;

// ─── Emitted roots ────────────────────────────────────────────────────────────
// Longest-first: `skills/gsd` (hermes category dir) must win over `skills` for
// `skills/gsd/...`, and `.agents/skills` must win over `.agents`.

const SKILLS_ROOTS = ['skills/gsd', '.agents/skills', 'skills'];
const HOOKS_ROOTS = ['.kimi-code/hooks', '.kimi/hooks', 'hooks'];

/** Source-of-truth command dir every skill/command surface converts from. */
const COMMANDS_SRC = 'commands/gsd';

/** Installer source file that emits the Cline/AGENTS.md instruction bodies as
 *  code literals (buildClineRulesBody / buildClineAgentsMdBody /
 *  buildClinePreToolUseHook). */
const CLINE_BODY_SRC = 'src/runtime-hooks-surface.cts';

/**
 * Installer source file that GENERATES the Windows-only `hooks/<name>.cmd` shim
 * wrapping a Codex hook's `.js` script (#3426). Same physical file as
 * CLINE_BODY_SRC — kept as its own named constant because the two constants
 * attribute unrelated transform code that happens to live in one file:
 * buildCodexHookWindowsShimIR / ensureCodexHooksJsonSessionStart /
 * ensureCodexHooksJsonEvent (verified via Memtrace: these are the ONLY writers
 * of a `.cmd` file anywhere in the installer — no other runtime's hook surface
 * builds one).
 */
const HOOKS_WINDOWS_SHIM_SRC = 'src/runtime-hooks-surface.cts';

/** Installer source file that emits the Hermes skill-category DESCRIPTION.md
 *  (writeHermesCategoryDescription) as a code literal. */
const INSTALLER_SRC = 'bin/install.js';

/** Module owning the #2544 `{"type":"commonjs"}` marker literal and the
 *  write/remove ownership predicate behind it. */
const COMMONJS_MARKER_SRC = 'src/commonjs-marker.cts';

/** Engine module that stages the native plugin adapter and writes the marker
 *  beside it (_installNativePluginIfDeclared). */
const INSTALL_ENGINE_SRC = 'src/install-engine.cts';

/** Source file holding the Kimi root-agent literal (runtime-artifact-layout.cts:303). */
const KIMI_ROOT_AGENT_SRC = 'src/runtime-artifact-layout.cts';

/**
 * Transform sources for the per-runtime agent-content pipeline (#2757).
 *
 * `runtime-artifact-conversion.cts` rewrites frontmatter (quoting, dropping `tools:`/
 * `color:`), reformats the tools list, and rewrites the hardcoded `.claude/` self-
 * reference to each runtime's own home (`applyAgentPathRewrites`,
 * `normalizeAgentBodyForRuntime`, the `convertClaudeAgentTo*Agent` family).
 * `install-effort-resolver.cts` (+ the `model-catalog.cts` primitives it calls)
 * resolves the `reasoning_effort` value that both Claude's `.md` (`effort:` frontmatter,
 * injected by `injectEffortFrontmatter` in bin/install.js) and Codex's `.toml`
 * (`model_reasoning_effort`) embed — "the same config-driven precedence chain" per
 * bin/install.js's own #443 comment.
 *
 * Verified empirically (#2757), not assumed: installing every runtime for a sample
 * agent and diffing the output against the raw repo `.md` (after normalizing the
 * install-time HOME/version substitutions the golden fixtures already normalize) shows
 * NO runtime — including Claude — emits a byte-identical copy. Every one rewrites at
 * least the frontmatter and the `.claude/skills` self-reference; Claude additionally
 * gets `effort:` injected. This is why `agents-verbatim` below is `derived`, not
 * `identity`, despite its (retained, historical) id.
 *
 * Deliberately excludes `bin/install.js`: that file also implements the final splice
 * (`injectEffortFrontmatter`, `generateCodexAgentToml`), but at 13k+ lines spanning
 * hooks, MCP config, uninstall, and every other installer concern, declaring it here
 * would be the blanket escape hatch ADR-2719 warns against — almost any PR touches SOME
 * line of it. A change localized to those two functions and not reachable through the
 * three files below stays unattributable and falls to the drift-ack file, which is the
 * documented escape hatch for exactly that case.
 *
 * ── Known follow-up, NOT included here on purpose (#2757 review) ────────────
 * The issue text also named `src/agent-tools-contract.cts` and
 * `src/agent-install-check.cts` (both touched by PR #2566, "derive Codex agent sandbox
 * from the tool"). Verified against THIS tree and excluded on the evidence:
 *   - `src/agent-tools-contract.cts` does not exist on `next` — #2566 ADDS it (+119/-0).
 *     A nonexistent path here would immediately fail the
 *     "every declared transform path exists in the repo" hygiene test in
 *     emitted-provenance.test.cjs, which exists precisely to catch a rule (or a
 *     suggested transform, as here) that cites a file that doesn't back real content.
 *   - `src/agent-install-check.cts` exists today and is READ-ONLY (`getAgentsDir`,
 *     `checkAgentsInstalled` — no fs.writeFileSync, no content transform); #2566
 *     nearly doubles it (+112/-1). Whether the addition becomes a real content-writer,
 *     a larger read-only diagnostic surface, or a helper called BY an already-declared
 *     file cannot be determined without reading #2566's actual diff, which review is
 *     explicit should not be fetched here. Declaring it on a line-count guess risks
 *     the exact false-attribution failure mode this whole table exists to prevent — a
 *     rule that looks fixed while resolving to the wrong causal story.
 * Interim safety net: if #2566 lands and either file becomes a real transform without
 * this list being updated, the differential (Phase 3) will correctly flag the moved
 * agent artifact as unattributable — that is the guard working, not a regression — and
 * unblocks via `tests/emitted-drift-ack.json` until this list is verified and extended
 * using the SAME method used for the three files above: build, install every runtime,
 * diff the output against the raw repo source, confirm which file's absence/presence
 * changes the bytes.
 */
const AGENT_TRANSFORM_SRCS = [
  'src/runtime-artifact-conversion.cts',
  'src/install-effort-resolver.cts',
  'src/model-catalog.cts',
];

// #3738: antigravity's global skills pass through the antigravity converter
// (src/runtime-artifact-conversion.cts, mirrored hand-authored in bin/install.js
// per ADR-1508), whose rewrites — e.g. ~/.claude/skills/ → ~/.gemini/config/skills/
// — can move emitted bytes with NO commands/gsd source changing. Declaring the
// transform here attributes that ripple class permanently, the same way
// AGENT_TRANSFORM_SRCS does for agents; scoped to runtime 'antigravity' so a
// converter change never blankets the other skills runtimes' attribution.
const ANTIGRAVITY_SKILL_TRANSFORM_SRCS = [
  'src/runtime-artifact-conversion.cts',
  'bin/install.js',
];

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
// `transforms` — OPTIONAL repo paths implementing the TRANSFORM that produces this
//                rule's emitted bytes (#2757). A `derived`/`code-derived` artifact's
//                bytes can move for a second reason `sources` alone cannot express:
//                the transform code changed, not the source it derives from.
//                Phase 3 (emitted-diff.cjs) attributes a moved path if the diff
//                satisfies EITHER `sources` OR `transforms`, reusing the same
//                `sourceSatisfiedBy` matcher for both so exact/prefix semantics stay
//                identical. `kind: 'identity'` rules MUST NOT declare a non-empty
//                `transforms` — enforced by `assertNoIdentityTransforms` below — because
//                an identity copy's bytes can only move when its source moves; that is
//                what makes it an identity.
//                May be a plain `string[]` (the common case) OR a `(match, ctx) => string[]`
//                function, mirroring `sources`, for a rule whose transform attribution
//                depends on WHICH emitted path matched — e.g. `hooks-built` below, where
//                only the `.cmd` shim sub-family has transform code at all; a static
//                array would either miss that or (worse) falsely blanket-attribute every
//                plain hook file to the shim generator that cannot move its bytes. A
//                dedicated rule for the `.cmd` sub-family was considered and rejected: it
//                is emitted ONLY on win32 (see `hooks-built` below), so on every non-
//                Windows CI lane it would match zero paths and fail as a "dead" rule.
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
    // Historical id — retained even though, per #2757, this is no longer identity.
    // Nothing else in the repo keys off this string (checked), and the `sources`
    // shape below is unchanged, so renaming it would only widen the diff.
    id: 'agents-verbatim',
    // #2757 (was `identity`): measured against origin/next's own committed fixtures,
    // the SAME emitted agents/<name>.md hashes DIFFERENTLY per runtime (e.g. codex vs
    // claude for gsd-nyquist-auditor.md) — impossible for a true verbatim copy.
    // Verified empirically by installing every runtime and diffing the output against
    // the raw repo source: no runtime reproduces it byte-for-byte. Every one rewrites
    // frontmatter quoting and the hardcoded `.claude/` self-reference
    // (src/runtime-artifact-conversion.cts); Claude additionally gets an `effort:`
    // line injected (src/install-effort-resolver.cts + src/model-catalog.cts). See
    // the #2757 design doc for the alternatives considered (per-runtime split,
    // per-runtime `kind`) and why this wholesale reclassification was chosen instead.
    kind: 'derived',
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
    transforms: AGENT_TRANSFORM_SRCS,
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
    // #2757 (issue text, PR #2566): a change to the conversion/effort code can move
    // every emitted .toml without touching any agents/*.md. See AGENT_TRANSFORM_SRCS.
    transforms: AGENT_TRANSFORM_SRCS,
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
    // `kind` is a single scalar per rule, and this rule's majority sub-family
    // (plain built hook files) is genuinely `derived` from hooks/<name> via
    // scripts/build-hooks.js. The `.cmd` shim sub-family is code-derived (see
    // the pattern-comment and `sources` comment below), but that does not
    // change this rule's `kind` — a per-match `kind` would need a dedicated
    // rule, which is exactly what was rejected above (dead on non-Windows CI
    // lanes). The `.cmd` branch's real (code-derived) provenance is instead
    // carried precisely by `sources`/`transforms` both pointing at
    // HOOKS_WINDOWS_SHIM_SRC — `assertNoIdentityTransforms` only constrains
    // `kind: 'identity'` rules, so a `derived` rule with a non-empty
    // `transforms` here is unaffected by that guard.
    kind: 'derived',
    roots: HOOKS_ROOTS,
    // Emitted from hooks/dist/, which scripts/build-hooks.js builds from hooks/.
    // Attribute to the REPO source a PR actually edits, not the build artifact.
    // Excludes Copilot's hook-registration JSON (next rule) — that is a code
    // literal, not a built script, and attributing it here resolved to a
    // nonexistent `hooks/gsd-session.json`. `package.json` is excluded for the
    // same reason (the #2544 `commonjs-marker` rule below): there is no
    // `hooks/package.json` in the repo to attribute to.
    //
    // `.cmd` shims are a SEPARATE, Windows-only emission path folded into this
    // SAME rule rather than a dedicated one (see the `transforms` doc above for
    // why a standalone rule would go dead on non-Windows CI lanes). Verified via
    // Memtrace: `hooks/<name>.cmd` is written at install time by
    // ensureCodexHooksJsonSessionStart / ensureCodexHooksJsonEvent (both gated
    // on `platform === 'win32'`) via buildCodexHookWindowsShimIR
    // (HOOKS_WINDOWS_SHIM_SRC, src/runtime-hooks-surface.cts). The `.cmd` bytes
    // are `@ECHO OFF\r\n@SETLOCAL\r\n@<runner> <script> %*\r\n` — built from the
    // install-time interpreter token and the absolute install path, plus a
    // hardcoded literal filename (e.g. `gsd-check-update.js`) baked into that
    // same source file. The wrapped `.js` file's NAME flows into the `.cmd`
    // bytes; its CONTENT never does — see the `sources` comment below for why
    // that rules out attributing to `hooks/<name>.js`.
    pattern: /^(?!gsd-session\.json$|package\.json$).+$/,
    // `package.json` (the CommonJS marker) is excluded here and owned by the
    // dedicated `commonjs-marker` rule below. #2717 attributed it inside THIS
    // rule, routing it to HOOKS_WINDOWS_SHIM_SRC because at that point
    // src/runtime-hooks-surface.cts was its only emitter (cursor/windsurf, plus
    // the codex copy block calling the same exported helper). #2544 adds a
    // second emitter — src/commonjs-marker.cts, via installSharedHooksBundle and
    // _installNativePluginIfDeclared — and two roots this rule does not cover
    // (`plugins`, `extensions`). A rule keyed to HOOKS_ROOTS with a single
    // source can express neither, so the marker moves to its own rule and that
    // rule names BOTH emitters. See the `commonjs-marker` entry below.
    //
    // `.cmd` shim bytes are code-derived (a literal template + the install-time
    // interpreter/path tokens in HOOKS_WINDOWS_SHIM_SRC) — the wrapped `.js`
    // file's NAME flows in (as a hardcoded literal filename inside that same
    // source file), but its CONTENT never does, so attributing `sources` to
    // `hooks/<name>.js` would be a false byte-provenance claim. Point `sources`
    // at the same file as `transforms`, matching the `code-derived` convention
    // used elsewhere in this table (copilot-hook-registration, cline-rules-
    // code-derived, hermes-category-description). The redundancy between
    // `sources` and `transforms` here is harmless — the mis-attribution was not.
    // No `package.json` arm here: the pattern above excludes it, so the branch
    // #2717 added for it is unreachable from this rule.
    sources: (m) => [m[0].endsWith('.cmd') ? HOOKS_WINDOWS_SHIM_SRC : `hooks/${m[0]}`],
    transforms: (m) => (m[0].endsWith('.cmd') ? [HOOKS_WINDOWS_SHIM_SRC] : []),
  },
  {
    id: 'commonjs-marker',
    kind: 'code-derived',
    // Every root GSD stages its own `.js` files into and therefore pins to
    // CommonJS: the hooks roots, plus the native plugin/extension dirs.
    roots: [...HOOKS_ROOTS, 'plugins', 'extensions'],
    // #2544: a `{"type":"commonjs"}` module-type marker, written as a code
    // literal so Node's ancestor walk resolves GSD's staged `.js` files as
    // CommonJS under an ambient `"type": "module"`. Like the Copilot
    // registration JSON above it is emitted, never built — there is no
    // `hooks/package.json` or `plugins/package.json` in the repo, so the
    // built-script rule would attribute it to a path that does not exist.
    // Sources are scoped PER ROOT, not declared as one flat union. Each root has
    // exactly one writer besides the shared marker module, and a flat list would
    // attribute every root to all of them — `extensions/package.json` to the
    // hooks-surface writer that never touches it, `.kimi/hooks/package.json` to
    // the native-plugin writer, and so on. That matters because
    // `emitted-diff.cjs` accepts the FIRST satisfied source: a flat list
    // containing `bin/install.js` lets any change anywhere in that 13k-line file
    // authorise marker drift for every root — the blanket escape hatch this
    // file's own agents-verbatim comment (above) refuses for the same reason.
    //
    //   hooks/ (shared bundle)  -> bin/install.js  (installSharedHooksBundle)
    //   hooks/ (#2717 runtimes) -> src/runtime-hooks-surface.cts + bin/install.js
    //                              (the codex copy block calls the exported helper)
    //   .kimi/hooks/            -> bin/install.js  (the kimi hooks-root bundle)
    //   plugins/, extensions/   -> src/install-engine.cts
    //                              (_installNativePluginIfDeclared)
    //
    // COMMONJS_MARKER_SRC is in every root: it owns the marker BYTES, so a change
    // to it can move any of them.
    // The rule ctx is `{ rel, runtime }` — it carries no `root`, so the root is
    // derived from `rel` here. Keying on a ctx field that does not exist would
    // send every path down one branch silently, which is the failure this
    // per-root split exists to prevent.
    pattern: /^package\.json$/,
    sources: (_m, ctx) => {
      const root = String(ctx.rel).replace(/\/package\.json$/, '');
      if (root === 'plugins' || root === 'extensions') {
        return [COMMONJS_MARKER_SRC, INSTALL_ENGINE_SRC];
      }
      // Both Kimi products install the shared bundle into their own native hook
      // root rather than under the generic Agent-Skills configDir (#2755).
      if (root === '.kimi/hooks' || root === '.kimi-code/hooks') {
        return [COMMONJS_MARKER_SRC, INSTALLER_SRC];
      }
      // 'hooks' — written by the shared bundle for most runtimes and by the
      // #2717 dedicated paths for cursor/windsurf/codex.
      return [COMMONJS_MARKER_SRC, INSTALLER_SRC, HOOKS_WINDOWS_SHIM_SRC];
    },
  },
  {
    // #3023: pi renames the shared hooks bundle's staged directory from the
    // default `hooks/` to `gsd-hooks/` (hostBehaviors.sharedHooksDirName,
    // bin/install.js's resolveSharedHooksDirName). Same family as `hooks-built`
    // above (built from hooks/ via scripts/build-hooks.js), staged under a
    // different root for exactly one runtime — a dedicated, `runtimes`-scoped
    // rule keeps that pi-only rename from ever being able to shadow another
    // host's `(rel, runtime)` pair, rather than folding 'gsd-hooks' into the
    // shared HOOKS_ROOTS list `hooks-built`/`commonjs-marker` both key off.
    // `package.json` (the CommonJS marker) is excluded here and owned by the
    // dedicated `pi-shared-hooks-commonjs-marker` rule below, mirroring how
    // `hooks-built` excludes it in favor of the shared `commonjs-marker` rule.
    id: 'pi-shared-hooks-built',
    kind: 'derived',
    runtimes: new Set(['pi']),
    roots: ['gsd-hooks'],
    pattern: /^(?!package\.json$).+$/,
    sources: (m) => [`hooks/${m[0]}`],
  },
  {
    // Companion to `pi-shared-hooks-built`: the CommonJS-mode marker written
    // into pi's renamed `gsd-hooks/` root by the same installSharedHooksBundle
    // call the generic `commonjs-marker` rule attributes for the `hooks/`
    // family. Kept as its own pi-scoped rule for the same reason as above.
    id: 'pi-shared-hooks-commonjs-marker',
    kind: 'code-derived',
    runtimes: new Set(['pi']),
    roots: ['gsd-hooks'],
    pattern: /^package\.json$/,
    sources: () => [COMMONJS_MARKER_SRC, INSTALLER_SRC],
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
    // #3738: see ANTIGRAVITY_SKILL_TRANSFORM_SRCS above — antigravity's skill
    // bytes are converter-produced, so a converter change explains the ripple.
    transforms: (_m, ctx) => (ctx.runtime === 'antigravity' ? ANTIGRAVITY_SKILL_TRANSFORM_SRCS : []),
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
  // #3547 removed `agents-md-code-derived` (roots: ['.agents'],
  // ^AGENTS\.md$) and `synthesized-gsd-defaults` (^\.gsd/defaults\.json$):
  // both paths only appeared in a manifest while the harness collapsed
  // configDir onto the sandbox HOME, walking HOME-level siblings
  // (cline's ~/.agents/AGENTS.md, every non-Claude runtime's
  // ~/.gsd/defaults.json). With the harness installing into each runtime's
  // real global subdirectory those files sit outside the walked configDir,
  // the rules matched nothing, and the totality guard's dead-rule arm fired
  // — exactly as designed. The files are still written, still covered by the
  // existence/config suites (kimi-upgrades, codex-config, install suites);
  // they are simply no longer manifest members to attribute.
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
    // `.kimi/package.json` and `.kimi-code/package.json` are the same literal
    // `{"type":"commonjs"}` CommonJS-mode marker as the root one, written into
    // each Kimi product's separate hooks root (installSharedHooksBundle; the
    // per-runtime root split is #2755).
    pattern: /^(\.gsd-profile|package\.json|\.kimi(-code)?\/package\.json|gsd-core\/VERSION|gsd-core\/\.gsd-runtime)$/,
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
 * @returns {{ruleId: string, kind: string, sources: string[], transforms: string[]}}
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
  let transforms;
  if (typeof rule.transforms === 'function') {
    transforms = rule.transforms(match, { rel, runtime });
    if (!Array.isArray(transforms)) {
      throw new Error(
        `emitted-provenance: rule "${rule.id}" transforms(match, ctx) must return an array, ` +
        `got ${typeof transforms} for ${rel}`,
      );
    }
  } else {
    // #2757: always an array, never undefined, so callers (Phase 3's diffEmitted)
    // never need a defensive `|| []`.
    transforms = Array.isArray(rule.transforms) ? rule.transforms : [];
  }
  return {
    ruleId: rule.id,
    kind: rule.kind,
    sources: rule.sources(match, { rel, runtime }),
    transforms,
  };
}

/**
 * Invariant (#2757): a `kind: 'identity'` rule may not declare a non-empty
 * `transforms`. An identity copy's bytes can only move when its source moves — that
 * is what makes it an identity; a transforms list on an identity rule would silently
 * readmit the exact false-attribution risk defect 2 found (a rule that is total and
 * "passes" while resolving to the wrong causal story).
 *
 * Called once at module load against the real PROVENANCE_RULES (fails fast on a
 * future authoring mistake) and exported so tests can drive it against an injected
 * corrupted table, matching this module's existing injectable-table convention.
 *
 * A function-valued `transforms` on an identity rule is rejected outright (without
 * invoking it) — an identity rule has no legitimate match-dependent transform story
 * by definition, so allowing the function form there would just be a slower path to
 * the same false-attribution risk this guard exists to catch.
 *
 * @param {Array} rules rule table (injectable)
 * @throws when any identity rule declares a non-empty transforms array or a function
 */
function assertNoIdentityTransforms(rules = PROVENANCE_RULES) {
  const violators = rules.filter(
    (r) => r.kind === 'identity'
      && (typeof r.transforms === 'function' || (Array.isArray(r.transforms) && r.transforms.length > 0)),
  );
  if (violators.length) {
    throw new Error(
      `emitted-provenance: identity rule(s) [${violators.map((r) => r.id).join(', ')}] ` +
      'declare a non-empty "transforms" — an identity copy\'s bytes can only move when ' +
      'its source moves, which is what makes it an identity. Reclassify the rule\'s ' +
      '"kind" (e.g. to "derived") if it legitimately needs a transforms list.',
    );
  }
}

// Fail fast: a malformed table crashes at require time rather than passing silently
// until some test happens to exercise the corrupted rule.
assertNoIdentityTransforms(PROVENANCE_RULES);

// ─── Manifest loading ─────────────────────────────────────────────────────────

/**
 * Build the emitted manifest set for every family, for real — one installer spawn
 * per runtime, exactly as `tests/helpers/emitted-runtime.cjs`'s `currentManifests()`
 * does for the differential check's CURRENT side.
 *
 * Pre-#2724 this read the committed `tests/fixtures/golden-install-parity/*.json`
 * snapshots. Phase 4 (ADR-2719) deletes those fixtures entirely — not just at HEAD,
 * at every future ref — so a fixture-reading implementation would throw at module
 * load on every commit from here forward, taking the Phase 2 totality guard down
 * with it (the totality guard is supposed to be the *replacement* for the golden
 * check, not another casualty of deleting it). Building from real installs instead
 * makes this the same honest, no-fixture-dependency shape as the differential's
 * current-tree side, and it needs no `fixturesDir` parameter because there is no
 * longer a fixture directory to point it at.
 *
 * Rejects a manifest whose build result is not a plain object — treating `0`,
 * `"s"`, `[]`, `null` or `true` as "no keys" would let the whole guard pass
 * vacuously on a corrupt build.
 */
/**
 * @param {object} [deps]  injected for testability (hostile-input coverage below) —
 *   production callers use the defaults.
 * @param {Array}    [deps.families]  MANIFEST_FAMILIES by default
 * @param {function} [deps.install]   runMinimalInstall by default
 * @param {function} [deps.build]     buildParityManifest by default
 * @param {function} [deps.clean]     cleanup by default
 */
function loadManifests({
  families = MANIFEST_FAMILIES,
  install = runMinimalInstall,
  build = buildParityManifest,
  clean = cleanup,
} = {}) {
  return families.map(({ name, runtime, scope }) => {
    const { configDir, root } = install({ runtime, scope });
    let parsed;
    try {
      parsed = build(configDir, root);
    } finally {
      clean(root);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(
        `emitted-provenance: build for ${name} must produce an object of path->hash, ` +
        `got ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
      );
    }
    return {
      file: `${name}.json`,
      // `claude-local` is the claude runtime at local scope; the descriptor lookup
      // keys on the runtime id, not the family name.
      runtime,
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
  PROVENANCE_RULES,
  SKILLS_ROOTS,
  KIMI_ROOT_AGENT_SRC,
  AGENT_TRANSFORM_SRCS,
  SOURCE_PREFIX_SUFFIX,
  HOOKS_ROOTS,
  COMMANDS_SRC,
  CLINE_BODY_SRC,
  HOOKS_WINDOWS_SHIM_SRC,
  INSTALLER_SRC,
  stripSkillPrefix,
  nativePluginDescriptor,
  matchOne,
  assertSafeRelPath,
  matchRules,
  attributeEmittedPath,
  assertNoIdentityTransforms,
  loadManifests,
  assertTotality,
};
