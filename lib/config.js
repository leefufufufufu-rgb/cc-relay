'use strict';
// Paths and config. Control-plane URL resolution order:
//   env CC_RELAY_CONTROL_PLANE  >  ~/.cc-relay/control-plane file  >  (unset)
const os = require('os');
const fs = require('fs');
const path = require('path');

const CC_DIR = process.env.CC_RELAY_DIR
  ? path.resolve(process.env.CC_RELAY_DIR)
  : path.join(os.homedir(), '.cc-relay');
const BIN_DIR = path.join(CC_DIR, 'bin');
const KEY_FILE = path.join(CC_DIR, 'device.key');
const CUR_FILE = path.join(CC_DIR, 'current-account');
const CP_FILE = path.join(CC_DIR, 'control-plane');
const UPSTREAM_PROXY_FILE = path.join(CC_DIR, 'upstream-proxy');

function controlPlane() {
  if (process.env.CC_RELAY_CONTROL_PLANE) return process.env.CC_RELAY_CONTROL_PLANE.trim();
  try {
    const f = fs.readFileSync(CP_FILE, 'utf8').trim();
    if (f) return f;
  } catch {}
  return ''; // not set: configure via `cc-relay install --control-plane <url>` or CC_RELAY_CONTROL_PLANE
}

// User's own static upstream egress proxy. claude's traffic exits through THIS, keeping a
// stable egress IP for the OAuth token (see HIGH-4). Resolution: env > file > '' (unset).
function readUpstreamProxy() {
  if (process.env.CC_RELAY_UPSTREAM_PROXY) return process.env.CC_RELAY_UPSTREAM_PROXY.trim();
  try {
    const f = fs.readFileSync(UPSTREAM_PROXY_FILE, 'utf8').trim();
    if (f) return f;
  } catch {}
  return '';
}
function saveUpstreamProxy(url) {
  fs.mkdirSync(CC_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(CC_DIR, 0o700); } catch {} // tighten even if it pre-existed at a looser mode
  fs.writeFileSync(UPSTREAM_PROXY_FILE, String(url).trim(), { mode: 0o600 });
}

module.exports = {
  CC_DIR,
  BIN_DIR,
  KEY_FILE,
  CUR_FILE,
  CP_FILE,
  UPSTREAM_PROXY_FILE,
  MAX_ROTATE: 3,
  controlPlane,
  readUpstreamProxy,
  saveUpstreamProxy,
};
