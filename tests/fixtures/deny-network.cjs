'use strict';

/**
 * Network-denial preload for offline-proof tests (Phase 4, #4404).
 *
 * Loaded via `NODE_OPTIONS=--require <this-file>` when spawning a child
 * process that must prove it made no network call. At module-load time this
 * monkey-patches every network entry point Node exposes to a script running
 * under the default CJS loader — `http`/`https` request/get, `net.Socket`'s
 * `connect`, `dns` lookup/resolve variants (both the callback API and the
 * separate `dns.promises` binding), `tls.connect`, `http2.connect`, and
 * `global(This).fetch` (when defined) — with a function that throws
 * synchronously, so ANY attempt to use one of these surfaces fails loudly
 * and immediately rather than hanging or silently succeeding against a real
 * or mocked network.
 *
 * No exports — this file is loaded purely for its side effects (per
 * `NODE_OPTIONS=--require`'s contract, which does not consume a return
 * value). The monkeypatches live for the lifetime of the process that loaded
 * this preload; because that process is always a short-lived child spawned
 * specifically for an offline-proof test, this never leaks into any other
 * test's process.
 */

function deny(name) {
  return function denyNetworkCall() {
    throw new Error(`deny-network: network access attempted during an offline-only test (${name})`);
  };
}

const http = require('node:http');
http.request = deny('http.request');
http.get = deny('http.get');

const https = require('node:https');
https.request = deny('https.request');
https.get = deny('https.get');

const net = require('node:net');
net.Socket.prototype.connect = deny('net.Socket.prototype.connect');

const dns = require('node:dns');
dns.lookup = deny('dns.lookup');
dns.resolve = deny('dns.resolve');
dns.resolve4 = deny('dns.resolve4');
dns.resolve6 = deny('dns.resolve6');
// dns.promises is a separate binding — patching the callback functions above
// does not touch it.
dns.promises.lookup = deny('dns.promises.lookup');
dns.promises.resolve = deny('dns.promises.resolve');
dns.promises.resolve4 = deny('dns.promises.resolve4');
dns.promises.resolve6 = deny('dns.promises.resolve6');

const tls = require('node:tls');
tls.connect = deny('tls.connect');

const http2 = require('node:http2');
http2.connect = deny('http2.connect');

if (typeof globalThis.fetch === 'function') {
  globalThis.fetch = deny('fetch');
}
