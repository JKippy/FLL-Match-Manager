// Public queue URL. The only hostname baked in here is the documented default for the
// named Cloudflare tunnel. Override it with QUEUE_HOSTNAME. A quick tunnel (trycloudflare)
// does not use this name; its URL comes from cloudflared's log.
'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_QUEUE_HOSTNAME = 'queue.kippykiyay.com';

function cleanHost(raw) {
  let h = String(raw || '').trim().toLowerCase();
  h = h.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  if (!/^[a-z0-9.-]+$/.test(h) || !h.includes('.') || h.startsWith('.') || h.endsWith('.') || h.includes('..')) return '';
  return h;
}

function hostnameFromEnv(env) {
  return cleanHost(env && env.QUEUE_HOSTNAME);
}

function hostnameInCloudflaredConfig(text) {
  const m = String(text || '').match(/^\s*(?:-\s*)?hostname:\s*(\S+)\s*$/m);
  return m ? cleanHost(m[1]) : '';
}

function parseQuickTunnelUrl(text) {
  const m = String(text || '').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return m ? m[0].toLowerCase() : '';
}

// What the Head Ref page should show. A configured hostname wins. The trycloudflare
// URL is used only when no named hostname is configured.
function displayedQueueUrl({ env, namedConfigText, status }) {
  const envHost = hostnameFromEnv(env);
  const cfgHost = hostnameInCloudflaredConfig(namedConfigText);
  if (envHost) return 'https://' + envHost;
  if (cfgHost) return 'https://' + cfgHost;
  if (String(namedConfigText || '').trim()) return 'https://' + DEFAULT_QUEUE_HOSTNAME;
  const quick = status && status.mode === 'quick' && parseQuickTunnelUrl(status.url);
  if (quick) return quick;
  return '';
}

// A named tunnel is configured when cloudflared/config.yml exists, or when
// CLOUDFLARED_CONFIG / QUEUE_TUNNEL_CONFIG points at a file. An empty
// CLOUDFLARED_CONFIG means "not configured" (quick tunnel), not the default path.
function namedConfigPath(env, cwd) {
  env = env || {};
  const exists = p => { try { return !!(p && fs.existsSync(p)); } catch (e) { return false; } };
  if (Object.prototype.hasOwnProperty.call(env, 'CLOUDFLARED_CONFIG')) return exists(env.CLOUDFLARED_CONFIG) ? env.CLOUDFLARED_CONFIG : '';
  if (env.QUEUE_TUNNEL_CONFIG) return exists(env.QUEUE_TUNNEL_CONFIG) ? env.QUEUE_TUNNEL_CONFIG : '';
  const def = path.join(cwd || process.cwd(), 'cloudflared', 'config.yml');
  return exists(def) ? def : '';
}

module.exports = {
  DEFAULT_QUEUE_HOSTNAME,
  cleanHost,
  hostnameFromEnv,
  hostnameInCloudflaredConfig,
  parseQuickTunnelUrl,
  displayedQueueUrl,
  namedConfigPath,
};
