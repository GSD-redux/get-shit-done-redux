'use strict';

/**
 * Single source of truth for the command-alias drift surface.
 *
 * Two parallel surfaces consume this: `scripts/check-alias-drift.cjs`, which
 * validates the built alias artifacts, and `.githooks/pre-commit`, which decides
 * when to run that validation. Until #2725 the hook's watched-path list had
 * drifted from the checker's family table until every pattern named either the
 * retired `sdk/` tree (ADR-0174) or a gitignored build output, so the guard was
 * silently inert. Both surfaces derive from this list now, and
 * `tests/precommit-alias-drift-hook.test.cjs` fails if they diverge again.
 */

/**
 * Alias families the drift check validates. `router` is the module basename,
 * shared by the `src/<router>.cts` source and the `gsd-core/bin/lib/<router>.cjs`
 * artifact it compiles to.
 */
const FAMILIES = Object.freeze([
  { commandAliases: 'STATE_COMMAND_ALIASES', subcommands: 'STATE_SUBCOMMANDS', router: 'state-command-router' },
  { commandAliases: 'VERIFY_COMMAND_ALIASES', subcommands: 'VERIFY_SUBCOMMANDS', router: 'verify-command-router' },
  { commandAliases: 'INIT_COMMAND_ALIASES', subcommands: 'INIT_SUBCOMMANDS', router: 'init-command-router' },
  { commandAliases: 'PHASE_COMMAND_ALIASES', subcommands: 'PHASE_SUBCOMMANDS', router: 'phase-command-router' },
  { commandAliases: 'PHASES_COMMAND_ALIASES', subcommands: 'PHASES_SUBCOMMANDS', router: 'phases-command-router' },
  { commandAliases: 'VALIDATE_COMMAND_ALIASES', subcommands: 'VALIDATE_SUBCOMMANDS', router: 'validate-command-router' },
  { commandAliases: 'ROADMAP_COMMAND_ALIASES', subcommands: 'ROADMAP_SUBCOMMANDS', router: 'roadmap-command-router' },
  { commandAliases: 'EVAL_COMMAND_ALIASES', subcommands: 'EVAL_SUBCOMMANDS', router: 'eval-command-router' },
].map(Object.freeze));

/** Basename of the generated alias table every family is checked against. */
const ALIAS_TABLE = 'command-aliases';

/**
 * Repo-relative TRACKED sources whose edit should re-run the drift check.
 *
 * Deliberately the `src/*.cts` sources, never the `gsd-core/bin/lib/*.cjs`
 * build outputs they compile to: those are gitignored, so
 * `git diff --cached --name-only` can never list them and a pre-commit guard
 * keyed on them can never fire (#2725).
 */
function stagedSourcePaths() {
  return [`src/${ALIAS_TABLE}.cts`, ...FAMILIES.map((family) => `src/${family.router}.cts`)];
}

module.exports = { FAMILIES, ALIAS_TABLE, stagedSourcePaths };
