#!/usr/bin/env node
// Read-only public queue. Separate process from the match timer. Loopback only.
'use strict';
const { createQueueServer } = require('./lib/queue-server');

function flag(name) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--' + name);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  return '';
}
function envOr(name, def) {
  const v = process.env[name];
  return v != null && v !== '' ? v : def;
}
const port = parseInt(flag('port') || envOr('QUEUE_PORT', '8081'), 10);
const mainPort = flag('main-port') || envOr('QUEUE_MAIN_PORT', '8080');
const upstream = flag('upstream') || envOr('QUEUE_UPSTREAM', `http://127.0.0.1:${mainPort}/internal/queue-snapshot`);
const pollMs = parseInt(flag('poll-ms') || envOr('QUEUE_POLL_MS', '2000'), 10);
const timeoutMs = parseInt(flag('timeout-ms') || envOr('QUEUE_TIMEOUT_MS', '1000'), 10);
const requestedHost = flag('host') || process.env.QUEUE_HOST || '';
if (requestedHost && requestedHost !== '127.0.0.1' && requestedHost !== 'localhost' && requestedHost !== '::1') {
  console.warn(`  Ignoring host ${requestedHost}. The public queue listens on 127.0.0.1 only.`);
}

const q = createQueueServer({ port, upstream, pollMs, timeoutMs });
q.listen().then(addr => {
  console.log(`\n  Public queue (loopback only): http://${addr.address}:${addr.port}/\n`);
}).catch(e => { console.error('  Queue server failed:', e && e.message || e); process.exit(1); });

process.on('uncaughtException', e => console.error('  [queue kept running]', e && e.message || e));
process.on('unhandledRejection', e => console.error('  [queue kept running]', e && e.message || e));
