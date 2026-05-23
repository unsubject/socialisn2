// @hono/node-server@1.19.x (transitive via @modelcontextprotocol/sdk)
// schedules a 500ms `forceClose` timer per request that calls
// `incoming.socket.destroySoon()`. Real net.Socket implements destroySoon;
// Fastify's app.inject() uses light-my-request's in-memory mock, which
// extends Stream.Duplex and doesn't.
//
// Result without this shim: an unhandled TypeError fires from a timer
// AFTER the MCP integration test has completed, which vitest catches
// and exits 1 with — even though all assertions passed.
//
// Shim destroySoon → destroy on the Duplex prototype. Real sockets keep
// their native implementation (this is a `typeof !== 'function'` guard).
// Production code paths never hit this shim because real sockets always
// have destroySoon; only the test mock benefits.

import { Duplex } from 'node:stream';

interface DestroySoonHost {
  destroy?: () => unknown;
}

const proto = Duplex.prototype as Duplex & { destroySoon?: () => unknown };
if (typeof proto.destroySoon !== 'function') {
  Object.defineProperty(proto, 'destroySoon', {
    value: function destroySoon(this: DestroySoonHost): unknown {
      return typeof this.destroy === 'function' ? this.destroy() : undefined;
    },
    writable: true,
    configurable: true,
  });
}
