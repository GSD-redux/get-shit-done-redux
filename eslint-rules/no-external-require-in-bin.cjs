'use strict';

/**
 * no-external-require-in-bin
 *
 * Flag any `require(...)` / `import ... from '...'` under `gsd-core/bin/**`
 * whose specifier is neither relative (`./`, `../`) nor a Node builtin
 * (including the `node:` prefix form).
 *
 * ## Why
 *
 * `gsd-core/bin/**` is copied by the installer into trees that have NO
 * `node_modules` (e.g. `~/.claude/gsd-core/`). An external (npm-package)
 * `require()`/`import` under this tree resolves fine in THIS repo (where
 * `node_modules/` exists) but throws `Cannot find module '<pkg>'` for every
 * installed user, because the package is never shipped there. #3477
 * follow-up: `src/pattern.cts` (compiled to `gsd-core/bin/lib/pattern.cjs`)
 * shipped `import { RE2JS } from 're2js'` and broke `verify` for every
 * installed user until the dependency was vendored under
 * `gsd-core/bin/lib/vendor/`.
 *
 * The fix for a genuine external-package dependency is never "add it back to
 * `dependencies`" — vendor the compiled artifact under
 * `gsd-core/bin/lib/vendor/` (a verbatim, third-party copy; see
 * `gsd-core/bin/lib/vendor/README.md`) and import it via a relative path
 * instead.
 *
 * ## Why this is ALSO registered on src/**\/*.cts
 *
 * Every `src/**\/*.cts` module compiles 1:1 into `gsd-core/bin/lib/*.cjs`
 * (ADR-457; `tsconfig.build.json` `rootDir: "src"`, `outDir:
 * "gsd-core/bin/lib"`), and the emitted `.cjs` mirrors are almost entirely
 * `eslint.config.mjs` global-`ignores`d as generated artifacts (lint the
 * source, not the tsc output) — so a rule registered ONLY on
 * `gsd-core/bin/**\/*.cjs` would never see a bad import re-introduced into an
 * already-migrated module. `src/pattern.cts`'s `import { RE2JS } from
 * 're2js'` is exactly this case: the compiled `gsd-core/bin/lib/pattern.cjs`
 * is on the ignore list, so only catching it at the `.cts` source closes the
 * gap. `TSImportEqualsDeclaration` (the `import x = require('./y.cjs')` form
 * used throughout `src/**\/*.cts` for CommonJS interop) is handled alongside
 * plain `ImportDeclaration` for this reason.
 */

const { builtinModules } = require('node:module');

const BUILTIN_MODULES = new Set(builtinModules);

/**
 * Is `specifier` a Node builtin module (with or without the `node:` prefix)?
 * @param {string} specifier
 * @returns {boolean}
 */
function isBuiltinModule(specifier) {
  const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
  return BUILTIN_MODULES.has(bare) || BUILTIN_MODULES.has(specifier);
}

/**
 * Is `specifier` a relative import (`./` or `../`)?
 * @param {string} specifier
 * @returns {boolean}
 */
function isRelativeSpecifier(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow require()/import of an external (non-relative, non-builtin) module under gsd-core/bin/** (installed trees have no node_modules)',
      category: 'Portability',
    },
    schema: [],
    messages: {
      externalRequireInBin:
        'External module "{{specifier}}" required/imported under gsd-core/bin/**: installed ' +
        'trees have no node_modules (gsd-core/bin/** is copied verbatim into e.g. ' +
        '~/.claude/gsd-core/), so this resolves here but throws "Cannot find module' +
        '" for every installed user. Vendor the artifact under gsd-core/bin/lib/vendor/ ' +
        '(see gsd-core/bin/lib/vendor/README.md) and import it via a relative path instead.',
    },
  },

  create(context) {
    /**
     * @param {import('eslint').Rule.Node} node — reported node
     * @param {string} specifier
     */
    function check(node, specifier) {
      if (typeof specifier !== 'string') return;
      if (isRelativeSpecifier(specifier)) return;
      if (isBuiltinModule(specifier)) return;
      context.report({ node, messageId: 'externalRequireInBin', data: { specifier } });
    }

    return {
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'require') return;
        const arg = node.arguments[0];
        if (!arg || arg.type !== 'Literal' || typeof arg.value !== 'string') return;
        check(node, arg.value);
      },
      ImportDeclaration(node) {
        check(node, node.source.value);
      },
      ImportExpression(node) {
        const arg = node.source;
        if (!arg || arg.type !== 'Literal' || typeof arg.value !== 'string') return;
        check(node, arg.value);
      },
      // `import foo = require('...')` — the CommonJS-interop form used
      // throughout src/**/*.cts (every src/*.cts compiles 1:1 into
      // gsd-core/bin/lib/*.cjs, so it is exactly as much "gsd-core/bin/**"
      // content as a hand-written .cjs file is).
      TSImportEqualsDeclaration(node) {
        const ref = node.moduleReference;
        if (!ref || ref.type !== 'TSExternalModuleReference') return;
        const arg = ref.expression;
        if (!arg || arg.type !== 'Literal' || typeof arg.value !== 'string') return;
        check(node, arg.value);
      },
    };
  },
};

module.exports = rule;
