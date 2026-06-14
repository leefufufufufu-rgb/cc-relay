'use strict';
// Control-plane client: device-key storage, enroll/token/rotate API calls, and the
// enroll/status/switch subcommands. This client only fetches short-lived leases; the
// returned token is injected into the target CLI and is never used to call upstream here.
const fs = require('fs');
const { CC_DIR, KEY_FILE, CUR_FILE, controlPlane } = require('./config');

function readDeviceKey() {
  try { return fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch { return ''; }
}
function saveDeviceKey(k) {
  fs.mkdirSync(CC_DIR, { recursive: true });
  fs.writeFileSync(KEY_FILE, k, { mode: 0o600 });
}
function readCurrent() {
  try { return fs.readFileSync(CUR_FILE, 'utf8').trim(); } catch { return ''; }
}
function writeCurrent(id) {
  try { fs.mkdirSync(CC_DIR, { recursive: true }); fs.writeFileSync(CUR_FILE, String(id)); } catch {}
}

async function api(pathname, body, deviceKey) {
  const base = controlPlane();
  if (!base) throw new Error('control plane not configured — run: cc-relay install --control-plane <url>');
  const headers = { 'Content-Type': 'application/json' };
  if (deviceKey) headers.Authorization = 'Bearer ' + deviceKey;
  const opts = { method: 'POST', headers, body: JSON.stringify(body || {}) };
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(20000);
  const res = await fetch(base + pathname, opts);
  let json = null;
  try { json = await res.json(); } catch {}
  const data = json && json.data !== undefined ? json.data : json;
  return { ok: res.ok, status: res.status, data };
}

async function enroll(code) {
  const r = await api('/api/v1/relay/enroll', { code });
  if (!r.ok || !r.data || !r.data.relay_key) return null;
  saveDeviceKey(r.data.relay_key);
  return r.data.relay_key;
}
async function getLease() {
  const dk = readDeviceKey();
  if (!dk) return null;
  const r = await api('/api/v1/relay/token', {}, dk);
  if (!r.ok || !r.data || !r.data.oauth_token) return null;
  return r.data;
}
async function rotateLease(accountId, reason) {
  const dk = readDeviceKey();
  if (!dk) return null;
  const r = await api('/api/v1/relay/token/rotate', { account_id: accountId, reason }, dk);
  if (!r.ok || !r.data || !r.data.oauth_token) return null;
  return r.data;
}

// ── subcommands ─────────────────────────────────────────────────────────────
async function enrollCmd(code) {
  if (!code) { console.error('usage: cc-relay enroll <code>'); process.exit(2); }
  const key = await enroll(code);
  if (!key) { console.error('enroll failed (code expired or network error).'); process.exit(1); }
  console.log('[OK] device enrolled.');
}
async function statusCmd() {
  console.log('control plane : ' + (controlPlane() || '(not configured)'));
  const dk = readDeviceKey();
  console.log('device        : ' + (dk ? 'enrolled' : 'not enrolled'));
  if (!dk) return;
  const l = await getLease();
  if (!l) { console.log('lease test    : FAILED (network / revoked / pool exhausted)'); return; }
  const t = l.oauth_token;
  const mask = t.length > 18 ? t.slice(0, 14) + '...' + t.slice(-4) : '***';
  console.log('lease test    : OK');
  console.log('  account_id = ' + l.account_id);
  console.log('  token      = ' + mask);
  console.log('  base_url   = ' + l.base_url);
}
async function switchCmd() {
  const cur = readCurrent();
  const l = await rotateLease(cur, 'manual');
  if (l) console.log('[OK] switched to account ' + l.account_id + '; restart to take effect.');
  else console.log('switch failed: no other account available.');
}

module.exports = {
  readDeviceKey, saveDeviceKey, readCurrent, writeCurrent,
  enroll, getLease, rotateLease,
  enrollCmd, statusCmd, switchCmd,
};
