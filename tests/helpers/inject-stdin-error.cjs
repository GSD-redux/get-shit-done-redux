'use strict';

/**
 * Deterministic stdin-read-failure injector for exit-code tests (ADR-3889
 * Phase 3, #3907).
 *
 * Cross-platform IO-failure injection must be done via method monkeypatching,
 * never mode-bit tricks (`fs.chmodSync(path, 0o000)` is bypassed by root in
 * Docker/CI and would assert zero coverage there). This module replaces
 * `process.stdin` with a fake EventEmitter BEFORE the target CLI module loads
 * — load it with `node -r tests/helpers/inject-stdin-error.cjs <target.cjs>`
 * — so the target's own `process.stdin.on('data'|'end'|'error', ...)`
 * subscriptions attach to the fake, and the fake emits ONLY `'error'`
 * (never `'data'`/`'end'`), deterministically exercising the module's
 * stdin-read-failure arm without any real pipe/fd involved.
 *
 * `-r` (require preload) runs before Node loads the main module, so the
 * spawned CLI still sees `require.main === module` for ITSELF — the
 * preload script's own module identity never satisfies that check — which is
 * what lets the target's `if (require.main === module)` CLI entry point run
 * normally, reading from (the now-fake) `process.stdin`.
 */

const { EventEmitter } = require('node:events');

const fakeStdin = new EventEmitter();
fakeStdin.setEncoding = () => {};
fakeStdin.resume = () => {};
fakeStdin.pause = () => {};

Object.defineProperty(process, 'stdin', {
  value: fakeStdin,
  configurable: true,
});

// Fire on the next tick — after the target module's require.main===module
// block has synchronously registered its 'data'/'end'/'error' listeners —
// so the 'error' event is never emitted to zero listeners.
setImmediate(() => {
  fakeStdin.emit('error', new Error('simulated stdin read failure (injected by inject-stdin-error.cjs)'));
});
