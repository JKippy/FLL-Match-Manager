#!/usr/bin/env node
// Runs cloudflared as its own process and writes the public queue URL where the
// match timer can read it. The timer never waits on this process.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const Q = require('./lib/queue-config');

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

const port = flag('port') || envOr('QUEUE_PORT', '8081');
const urlFile = flag('queue-url-file') || envOr('QUEUE_URL_FILE', path.join(process.cwd(), 'data', 'queue-public.json'));
const bin = envOr('CLOUDFLARED_BIN', 'cloudflared');
const cfgPath = Q.namedConfigPath(process.env, process.cwd());

function writeStatus(obj) {
  try {
    fs.mkdirSync(path.dirname(urlFile), { recursive: true });
    const tmp = urlFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, urlFile);
  } catch (e) { console.error('  Could not write the public queue URL:', e.message); }
}

let child;
if (cfgPath) {
  let text = '';
  try { text = fs.readFileSync(cfgPath, 'utf8'); } catch (e) {}
  const url = Q.displayedQueueUrl({ env: process.env, namedConfigText: text, status: null });
  writeStatus({ mode: 'named', url, running: true, at: Date.now() });
  console.log(`  Named tunnel ${url || '(no hostname)'} via ${cfgPath}`);
  child = spawn(bin, ['tunnel', '--config', cfgPath, 'run'], { stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('exit', (code, sig) => {
    writeStatus({ mode: 'named', url, running: false, at: Date.now() });
    console.error(`  cloudflared exited (${sig || code}). The public hostname is unchanged. The match timer is not this process.`);
  });
} else {
  const target = `http://127.0.0.1:${port}`;
  console.log(`  No named tunnel config. Starting a quick tunnel to ${target}`);
  console.log('  The trycloudflare.com URL changes every run. For the event, use cloudflared/config.yml (see the README).');
  child = spawn(bin, ['tunnel', '--url', target, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let acc = '';
  let published = '';
  const onData = buf => {
    const s = buf.toString();
    process.stderr.write(s);
    acc = (acc + s).slice(-100000);
    const url = Q.parseQuickTunnelUrl(acc);
    if (url && url !== published) {
      published = url;
      writeStatus({ mode: 'quick', url, running: true, at: Date.now() });
      console.error(`\n  Public queue URL: ${url}\n`);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', (code, sig) => {
    writeStatus({ mode: 'quick', url: '', running: false, at: Date.now() });
    console.error(`  Quick tunnel exited (${sig || code}). The match timer is not this process.`);
  });
}
child.on('error', e => console.error('  Could not start cloudflared:', e.message, '\n  Install it and try again (see the README).'));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { child.kill('SIGTERM'); } catch (e) {} process.exit(0); });
