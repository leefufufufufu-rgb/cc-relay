'use strict';
// Cross-platform install/uninstall: write claude/cc/cc-relay shims, prepend PATH, patch
// ~/.claude/settings.json (strip injected env keys + add a Stop hook), and enroll.
// settings.json is handled with JSON.parse/stringify, which is safe by construction.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { CC_DIR, BIN_DIR, CP_FILE } = require('./config');
const { enroll } = require('./relay');

const isWin = process.platform === 'win32';
const NODE = process.execPath;                       // absolute node path (most robust)
const CLI = path.resolve(__dirname, '..', 'cli.js'); // absolute entry of this package
const SETTINGS = process.env.CC_RELAY_SETTINGS
  ? path.resolve(process.env.CC_RELAY_SETTINGS)
  : path.join(os.homedir(), '.claude', 'settings.json');
const INJECTED_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
const HOOK_CMD = '"' + NODE + '" "' + CLI + '" _hook';

function writeShims() {
  fs.mkdirSync(CC_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(CC_DIR, 0o700); } catch {} // tighten even if it pre-existed at a looser mode
  fs.mkdirSync(BIN_DIR, { recursive: true, mode: 0o700 });
  if (isWin) {
    const body = '@echo off\r\n"' + NODE + '" "' + CLI + '" %*\r\n';
    for (const n of ['claude.cmd', 'cc.cmd', 'cc-relay.cmd']) fs.writeFileSync(path.join(BIN_DIR, n), body);
  } else {
    const body = '#!/bin/sh\nexec "' + NODE + '" "' + CLI + '" "$@"\n';
    for (const n of ['claude', 'cc', 'cc-relay']) fs.writeFileSync(path.join(BIN_DIR, n), body, { mode: 0o755 });
  }
}

function prependPath() {
  if (isWin) {
    const bin = BIN_DIR.replace(/'/g, "''");
    const ps = [
      "$bin = '" + bin + "'",
      "$u = [Environment]::GetEnvironmentVariable('PATH','User'); if (-not $u) { $u = '' }",
      "$parts = @($u -split ';' | Where-Object { $_ -and ($_ -ne $bin) })",
      "[Environment]::SetEnvironmentVariable('PATH', ((@($bin) + $parts) -join ';'), 'User')",
    ].join('; ');
    try { execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { stdio: 'ignore' }); } catch (e) {
      console.error('[cc-relay] could not set user PATH (add ' + BIN_DIR + ' to PATH manually): ' + e.message);
    }
  } else {
    const line = 'export PATH="' + BIN_DIR + ':$PATH"  # cc-relay';
    const home = os.homedir();
    const rcs = ['.zshrc', '.bashrc', '.profile'].map(f => path.join(home, f));
    let touched = false;
    for (const rc of rcs) {
      if (!fs.existsSync(rc)) continue;
      const c = fs.readFileSync(rc, 'utf8');
      if (!c.includes(BIN_DIR)) fs.appendFileSync(rc, '\n' + line + '\n');
      touched = true;
    }
    if (!touched) fs.appendFileSync(path.join(home, '.profile'), '\n' + line + '\n');
  }
}

function removePath() {
  if (isWin) {
    const bin = BIN_DIR.replace(/'/g, "''");
    const ps = [
      "$bin = '" + bin + "'",
      "$u = [Environment]::GetEnvironmentVariable('PATH','User'); if (-not $u) { $u = '' }",
      "$parts = @($u -split ';' | Where-Object { $_ -and ($_ -ne $bin) })",
      "[Environment]::SetEnvironmentVariable('PATH', ($parts -join ';'), 'User')",
    ].join('; ');
    try { execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { stdio: 'ignore' }); } catch {}
  } else {
    const home = os.homedir();
    for (const f of ['.zshrc', '.bashrc', '.profile']) {
      const rc = path.join(home, f);
      if (!fs.existsSync(rc)) continue;
      const kept = fs.readFileSync(rc, 'utf8').split('\n').filter(l => !l.includes(BIN_DIR) && !/# cc-relay$/.test(l));
      fs.writeFileSync(rc, kept.join('\n'));
    }
  }
}

function patchSettings() {
  let obj = {};
  try {
    fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
    if (fs.existsSync(SETTINGS)) {
      fs.copyFileSync(SETTINGS, SETTINGS + '.before-ccrelay.bak');
      try { fs.chmodSync(SETTINGS + '.before-ccrelay.bak', 0o600); } catch {} // backup may hold a pre-existing token
      obj = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
    }
  } catch (e) {
    console.error('[cc-relay] could not parse settings.json, skipping hook (host CLI unaffected): ' + e.message);
    return;
  }
  if (obj.env && typeof obj.env === 'object') for (const k of INJECTED_KEYS) delete obj.env[k];
  obj.hooks = obj.hooks && typeof obj.hooks === 'object' ? obj.hooks : {};
  let stop = Array.isArray(obj.hooks.Stop) ? obj.hooks.Stop : [];
  // Drop any prior cc-relay hook (our unique '_hook' marker) so version/path changes
  // (e.g. an old powershell -File hook) are replaced rather than duplicated/left stale.
  stop = stop.filter(g => !JSON.stringify(g).includes('_hook'));
  stop.push({ matcher: '', hooks: [{ type: 'command', command: HOOK_CMD, timeout: 10 }] });
  obj.hooks.Stop = stop;
  try {
    fs.writeFileSync(SETTINGS, JSON.stringify(obj, null, 2) + '\n');
  } catch (e) {
    const bak = SETTINGS + '.before-ccrelay.bak';
    if (fs.existsSync(bak)) fs.copyFileSync(bak, SETTINGS);
    console.error('[cc-relay] could not write settings.json, rolled back: ' + e.message);
  }
}

function restoreSettings() {
  const bak = SETTINGS + '.before-ccrelay.bak';
  if (fs.existsSync(bak)) { fs.copyFileSync(bak, SETTINGS); return; }
  // no backup: strip our own Stop hook entry
  try {
    if (!fs.existsSync(SETTINGS)) return;
    const obj = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
    if (obj.hooks && Array.isArray(obj.hooks.Stop)) {
      obj.hooks.Stop = obj.hooks.Stop.filter(g => !JSON.stringify(g).includes('_hook'));
      if (obj.hooks.Stop.length === 0) delete obj.hooks.Stop;
      if (Object.keys(obj.hooks).length === 0) delete obj.hooks;
    }
    fs.writeFileSync(SETTINGS, JSON.stringify(obj, null, 2) + '\n');
  } catch {}
}

async function install(args) {
  let code = '';
  let cp = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--enroll') code = args[++i];
    else if (args[i] === '--control-plane') cp = args[++i];
  }
  fs.mkdirSync(CC_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(BIN_DIR, { recursive: true, mode: 0o700 });
  if (cp) {
    fs.writeFileSync(CP_FILE, cp.trim(), { mode: 0o600 });
  } else if (!fs.existsSync(CP_FILE) && !process.env.CC_RELAY_CONTROL_PLANE) {
    console.error('control plane required: cc-relay install --control-plane <url> [--enroll <code>]');
    process.exit(2);
  }
  writeShims();
  console.log('[1/4] installed claude/cc/cc-relay shims -> ' + BIN_DIR);
  prependPath();
  console.log('[2/4] prepended ' + BIN_DIR + ' to PATH (open a new terminal to pick it up)');
  patchSettings();
  console.log('[3/4] settings.json updated (stripped injected env keys + added Stop hook, backup .before-ccrelay.bak)');
  if (code) {
    const k = await enroll(code);
    console.log(k ? '[4/4] device enrolled.' : '[4/4] enroll failed (code may be expired); run: cc-relay enroll <code>');
  } else {
    console.log('[4/4] not enrolled. run: cc-relay enroll <code>');
  }
  console.log('\nDone. Open a new terminal and run `claude` as usual.');
}

function uninstall() {
  removePath();
  console.log('[1/3] removed ' + BIN_DIR + ' from PATH');
  restoreSettings();
  console.log('[2/3] restored settings.json (from backup, or stripped our hook)');
  try { fs.rmSync(CC_DIR, { recursive: true, force: true }); } catch {}
  console.log('[3/3] removed ' + CC_DIR + '\nUninstalled. Open a new terminal to take effect.');
}

module.exports = { install, uninstall, writeShims, patchSettings, restoreSettings, SETTINGS, HOOK_CMD };
