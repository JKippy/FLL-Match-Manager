#!/usr/bin/env node
// Event day: match timer, loopback queue server, and cloudflared.
// The queue server and cloudflared are other processes. If either exits, the timer keeps running.
'use strict';
const { spawn } = require('child_process');
const path = require('path');

const node = process.execPath;
const root = path.join(__dirname, '..');
const args = process.argv.slice(2);

function flag(name) {
  const i = args.indexOf('--' + name);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  return '';
}

const env = Object.assign({}, process.env);
const port = flag('port') || env.PORT || '8080';
if (!env.QUEUE_MAIN_PORT) env.QUEUE_MAIN_PORT = String(port);

function start(script, extra) {
  const child = spawn(node, [path.join(root, script), ...extra], { stdio: 'inherit', env });
  child.on('exit', (code, sig) => {
    const why = sig || (code == null ? 0 : code);
    if (script === 'server.js') {
      console.error('\n  Match timer stopped (' + why + ').');
      process.exit(code == null ? 1 : code);
    }
    console.error('\n  ' + script + ' stopped (' + why + '). The match timer is still running.');
  });
  return child;
}

start('server.js', args);
start('queue-server.js', []);
start('tunnel.js', []);
