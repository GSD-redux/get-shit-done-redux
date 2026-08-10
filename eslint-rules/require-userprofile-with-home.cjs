'use strict';

/**
 * require-userprofile-with-home
 *
 * Flag test files that assign `process.env.HOME` without also referencing
 * `USERPROFILE` anywhere in the file.
 *
 * ## What this enforces (G6)
 *
 * Program-level: collect assignments to `process.env.HOME`
 * (`process.env.HOME = …` / `process.env['HOME'] = …`); track whether
 * `USERPROFILE` appears anywhere in the file (any reference). At
 * `Program:exit`, if HOME is assigned and `USERPROFILE` never appears, report
 * each HOME assignment.
 *
 * Message: Windows uses `USERPROFILE`, not `HOME` — set
 * `process.env.USERPROFILE` alongside.
 *
 * DEFECT category: DEFECT.WINDOWS-TEST-PORTABILITY
 */

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require process.env.USERPROFILE to be set alongside process.env.HOME (Windows portability)',
      category: 'Portability',
    },
    schema: [],
    messages: {
      missingUserProfile:
        'Assigning process.env.HOME without process.env.USERPROFILE is not portable ' +
        '(DEFECT.WINDOWS-TEST-PORTABILITY): Windows uses USERPROFILE as the home ' +
        'directory environment variable, not HOME. Set process.env.USERPROFILE ' +
        'alongside process.env.HOME.',
    },
  },

  create(context) {
    /** Collected HOME assignment nodes */
    const homeAssignments = [];

    /** Whether a real process.env.USERPROFILE = … assignment exists in the file */
    let userProfileAssigned = false;

    /**
     * Returns true if node is an assignment to process.env[key] or
     * process.env.key for the given key name.
     *
     * Recognized shapes (as the left-hand side of AssignmentExpression):
     *   process.env.KEY       — MemberExpression(MemberExpression, Identifier)
     *   process.env['KEY']    — MemberExpression(MemberExpression, Literal, computed=true)
     *
     * @param {import('eslint').Rule.Node} lhs — left side of AssignmentExpression
     * @param {string} key — the env var name to check
     * @returns {boolean}
     */
    function isProcessEnvAssignment(lhs, key) {
      if (!lhs || lhs.type !== 'MemberExpression') return false;
      const obj = lhs.object;
      if (!obj || obj.type !== 'MemberExpression') return false;

      // obj must be process.env
      if (
        obj.computed ||
        obj.object.type !== 'Identifier' ||
        obj.object.name !== 'process' ||
        obj.property.type !== 'Identifier' ||
        obj.property.name !== 'env'
      ) {
        return false;
      }

      // Property must be key (identifier or string literal)
      if (!lhs.computed) {
        return lhs.property.type === 'Identifier' && lhs.property.name === key;
      } else {
        return (
          lhs.property.type === 'Literal' && lhs.property.value === key
        );
      }
    }

    return {
      AssignmentExpression(node) {
        if (isProcessEnvAssignment(node.left, 'HOME')) {
          homeAssignments.push(node);
        }
        // Track actual USERPROFILE assignments (not mere text/comment mentions)
        if (isProcessEnvAssignment(node.left, 'USERPROFILE')) {
          userProfileAssigned = true;
        }
      },

      'Program:exit'() {
        if (homeAssignments.length === 0) return;

        // Only suppress if USERPROFILE is actually ASSIGNED (not just mentioned in a comment)
        if (userProfileAssigned) return;

        for (const node of homeAssignments) {
          context.report({ node, messageId: 'missingUserProfile' });
        }
      },
    };
  },
};

module.exports = rule;
