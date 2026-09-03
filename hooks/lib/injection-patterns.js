'use strict';

/**
 * injection-patterns.js — the shared prompt-injection pattern list (#3504, epic #1900).
 *
 * Single source of truth for the standard injection signatures used by BOTH
 * gsd-prompt-guard.js (PreToolUse scan of writes into .planning/) and
 * gsd-read-injection-scanner.js (PostToolUse scan of Read/WebFetch/WebSearch
 * content). Previously each hook carried a byte-identical copy ("inlined for
 * hook independence") that could silently drift — a pattern tightened in one
 * would stop protecting the other surface.
 *
 * Why a shared lib require is safe here (the old inlining rationale, retired):
 * the installer stages hooks/lib/ from the GSD_HOOK_LIB_FILES allowlist for the
 * shared-bundle surfaces (Claude-family settings.json runtimes and Kimi), the
 * Cursor stager auto-discovers require('./lib/...') in staged scripts and fails
 * the install loudly when a helper is missing (#2587), and the plugin path
 * ships this directory wholesale.
 *
 * Deliberately NOT unified with src/security.cts's scanForInjection set: that
 * set runs inside the compiled lib tree; hooks must stay loadable standalone
 * without it. The two lists are different surfaces by design, not drift.
 *
 * Keep this file free of literal 'gsd:' text — the stager rewrites that marker
 * in staged hook content.
 */

const INJECTION_PATTERNS = Object.freeze([
  // #4016: ONE filler-tolerant imperative-override pattern. It REPLACES the
  // five narrow verb patterns (ignore x2 / disregard / forget / override) that
  // used to sit here: they tolerated no filler between verb and noun, so a
  // planted "forget all of your ..." phrasing (measured in the wild) matched
  // nothing. A single pattern rather than narrow-plus-combined because both
  // consumers count one finding PER PATTERN toward the severity threshold
  // (3 = HIGH, blockable under security.injection_blocking): overlapping
  // patterns made one sentence count twice and pushed a two-phrasing LOW
  // payload to HIGH (PR #4061 review).
  //   verbs    ignore|disregard|forget|discard|override. `override` carries
  //            the old `override system|previous prompt|instructions` family;
  //            `discard` is the synonym seen in the same planted phrasings.
  //   fillers  at least ONE of all|of|the|your|my|<qualifier> must sit between
  //            verb and noun (a lookahead, no repetition). Bare "override
  //            rules" / "ignore instructions" are ordinary repo prose
  //            (measured: 6 hits across docs and source) and stay unmatched.
  //   tails    `disregard (all) previous` with no noun, and bare `forget` +
  //            `instructions`, are kept verbatim because the old narrow
  //            patterns accepted them; the superset is pinned by
  //            tests/injection-patterns-parity.security.test.cjs.
  //   known FP determined linter-doc prose such as "ignore (the) rules" trips
  //            a single-pattern LOW advisory; one pattern can never block.
  /(?:ignore|disregard|forget|discard|override)\s+(?=(?:all|of|the|your|my|system|previous|prior|above|earlier)\s)(?:all\s+)?(?:of\s+)?(?:the\s+|your\s+|my\s+)?(?:(?:system|previous|prior|above|earlier)\s+)?(?:instructions|directives|prompts?|rules)|disregard\s+(?:all\s+)?previous|forget\s+instructions/i,
  /you\s+are\s+now\s+(?:a|an|the)\s+/i,
  /act\s+as\s+(?:a|an|the)\s+(?!plan|phase|wave)/i,
  /pretend\s+(?:you(?:'re| are)\s+|to\s+be\s+)/i,
  /from\s+now\s+on,?\s+you\s+(?:are|will|should|must)/i,
  /(?:print|output|reveal|show|display|repeat)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions)/i,
  /<\/?(?:system|assistant|human)>/i,
  /\[SYSTEM\]/i,
  /\[INST\]/i,
  /<<\s*SYS\s*>>/i,
]);

// Short single-line label for a matched pattern, used for both the rendered
// advisory prose and the typed `findings[].match` field in BOTH consumer
// hooks. The raw regex source is not user-facing: the #4016 superset pattern
// is ~280 characters, and gsd-prompt-guard.js echoed it verbatim into its
// advisory (PR #4061 review nit). Byte-identical to the transform
// gsd-read-injection-scanner.js carried inline since #3523, hoisted here so
// one finding renders the same way in both hooks. Both hooks already require
// this module, so this adds no new staging dependency.
function describePattern(pattern) {
  return pattern.source.replace(/\\s\+/g, '-').replace(/[()\\]/g, '').substring(0, 50);
}

module.exports = { INJECTION_PATTERNS, describePattern };
