'use strict';
// Resolve the real target CLI executable (excluding our own shim dir) and classify
// rate-limit / auth error text from its output or transcript.
const fs = require('fs');
const path = require('path');
const { BIN_DIR } = require('./config');

function resolveRealClaude() {
  const isWin = process.platform === 'win32';
  const exts = isWin
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map(e => e.toLowerCase())
    : [''];
  const selfDir = path.resolve(BIN_DIR).toLowerCase();
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const found = [];
  for (const d of dirs) {
    let rd;
    try { rd = path.resolve(d); } catch { continue; }
    if (rd.toLowerCase() === selfDir) continue; // skip our own shim dir (avoid recursion)
    for (const ext of exts) {
      const cand = path.join(rd, 'claude' + ext);
      try { if (fs.statSync(cand).isFile()) found.push(cand); } catch {}
    }
  }
  if (isWin) {
    const exe = found.find(f => f.toLowerCase().endsWith('.exe'));
    if (exe) return exe; // direct native .exe (e.g. WinGet)
    // npm's claude.cmd actually launches a bundled bin/claude.exe — target that exe directly
    // so we spawn a real executable (clean args, no shell) instead of going through the .cmd.
    const cmd = found.find(f => f.toLowerCase().endsWith('.cmd'));
    if (cmd) {
      const nested = path.join(path.dirname(cmd), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      try { if (fs.statSync(nested).isFile()) return nested; } catch {}
      return cmd; // fallback: a .cmd with no bundled exe (run via cmd.exe /c in run.js)
    }
  }
  return found[0] || null;
}

function classifyRateLimit(text) {
  const t = String(text || '').toLowerCase();
  if (/rate.?limit|usage limit|session limit|too many requests|overloaded|\b429\b/.test(t)) return 'rate_limit';
  if (/authentication_error|authentication_failed|invalid bearer|invalid.?x-api-key|unauthorized|\b401\b/.test(t)) return 'authentication_failed';
  return null;
}

module.exports = { resolveRealClaude, classifyRateLimit };
