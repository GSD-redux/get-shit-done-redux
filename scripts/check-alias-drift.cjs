'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');
const { FAMILIES, ALIAS_TABLE } = require('./lib/alias-drift-families.cjs');

const ROOT = path.resolve(__dirname, '..');
const aliasesPath = path.join(ROOT, 'gsd-core', 'bin', 'lib', `${ALIAS_TABLE}.cjs`);

function fail(message) {
  process.stderr.write(`${message}\n`);
  throw new ExitError(1);
}

function ensureArray(value, name) {
  if (!Array.isArray(value)) {
    fail(`check:alias-drift: expected ${name} to be an array`);
  }
}

function assertNoDuplicates(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) {
      fail(`check:alias-drift: duplicate ${label} value "${value}"`);
    }
    seen.add(value);
  }
}

function main() {
  if (!fs.existsSync(aliasesPath)) {
    fail(`check:alias-drift: missing ${path.relative(ROOT, aliasesPath)}`);
  }

  const aliases = require(aliasesPath);

  const families = FAMILIES.map((family) => ({
    commandAliases: family.commandAliases,
    subcommands: family.subcommands,
    routerPath: path.join(ROOT, 'gsd-core', 'bin', 'lib', `${family.router}.cjs`),
  }));

  for (const family of families) {
    const commandAliases = aliases[family.commandAliases];
    const subcommands = aliases[family.subcommands];

    ensureArray(commandAliases, family.commandAliases);
    ensureArray(subcommands, family.subcommands);

    const derivedSubcommands = commandAliases.map((entry) => entry && entry.subcommand);
    assertNoDuplicates(derivedSubcommands, `${family.commandAliases}.subcommand`);

    if (derivedSubcommands.length !== subcommands.length) {
      fail(
        `check:alias-drift: ${family.subcommands} length ${subcommands.length} does not match ` +
        `${family.commandAliases} length ${derivedSubcommands.length}`,
      );
    }

    for (let i = 0; i < derivedSubcommands.length; i++) {
      if (derivedSubcommands[i] !== subcommands[i]) {
        fail(
          `check:alias-drift: ${family.subcommands}[${i}] = "${subcommands[i]}" ` +
          `does not match ${family.commandAliases}[${i}].subcommand = "${derivedSubcommands[i]}"`,
        );
      }
    }

    const routerSource = fs.readFileSync(family.routerPath, 'utf8');
    if (!routerSource.includes(family.subcommands)) {
      fail(
        `check:alias-drift: ${path.relative(ROOT, family.routerPath)} does not reference ${family.subcommands}`,
      );
    }
  }

  process.stdout.write('check:alias-drift ok\n');
}

runMain(main);
