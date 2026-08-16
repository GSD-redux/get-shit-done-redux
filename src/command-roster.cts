'use strict';

/**
 * Command Roster Module
 *
 * Read-only helper for discovering canonical commands/gsd command stems and
 * applying the shared GSD slash-command namespace transform.
 */

import path from 'node:path';
import fs from 'node:fs';
// #2874 (ADR-58 cleanup phase): readGsdCommandNames is reached from
// installRuntimeArtifacts's call tree (skillsKind's stage() closure reads it
// for cross-referencing), but COMMANDS_DIR (below) is resolved by walking up
// from THIS MODULE'S OWN compiled __dirname to locate the GSD PACKAGE'S OWN
// commands/gsd/ source tree — not anything under the install destination.
// This is the exact same "package's own source, not the destination" case
// findInstallSourceRoot/findAgentsSourceRoot document in
// runtime-artifact-layout.cts's Step 2 (see that comment and
// install-fs-adapter.cts's module doc, "DELIBERATELY NOT ROUTED" section):
// an injected destination adapter's store starts empty and is never seeded
// with the real package's own on-disk layout, so routing this read through
// installFs() would make a fake-adapter install either silently return `[]`
// (via the ENOENT swallow below) or resolve wrong stems — never loudly fail,
// and never see the real package tree either way. This directory read
// therefore deliberately stays on real `node:fs`, unrouted — same rule,
// applied consistently, not an inconsistency with the routed staging calls
// elsewhere in this call tree. `readCmdNames` in
// scripts/fix-slash-commands.cjs also uses real `node:fs` directly (that
// script lives outside src/ and is also a standalone CLI tool), so its
// directory-read logic is reimplemented here against real fs instead of
// delegated to, keeping the pure regex/transform helpers below delegated as
// before.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const slashCommandTransformer = require('../../../scripts/fix-slash-commands.cjs') as {
  readCmdNames: () => string[];
  transformContentToHyphen: (src: string, cmdNames: string[]) => string;
  transformContent: (src: string, cmdNames: string[]) => string;
  buildPattern: (cmdNames: string[]) => RegExp | null;
  buildColonPattern: (cmdNames: string[]) => RegExp | null;
};

// Mirrors scripts/fix-slash-commands.cjs's own `COMMANDS_DIR` computation
// (`path.join(__dirname, '..', 'commands', 'gsd')` from repo-root/scripts) —
// same target directory, resolved from this module's own compiled location
// (repo-root/gsd-core/bin/lib) instead, so the walk-up depth differs.
const COMMANDS_DIR = path.join(__dirname, '..', '..', '..', 'commands', 'gsd');

function readGsdCommandNames(): string[] {
  try {
    return fs.readdirSync(COMMANDS_DIR)
      .filter((f: string) => f.endsWith('.md'))
      .map((f: string) => f.replace(/\.md$/, ''));
  } catch (err) {
    // Only swallow the missing-directory case — mirrors readCmdNames' own
    // contract (scripts/fix-slash-commands.cjs).
    if (err instanceof Error && (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return [];
  }
}

export = {
  readGsdCommandNames,
  transformContentToHyphen: slashCommandTransformer.transformContentToHyphen,
  transformContent: slashCommandTransformer.transformContent,
  buildPattern: slashCommandTransformer.buildPattern,
  buildColonPattern: slashCommandTransformer.buildColonPattern,
};
