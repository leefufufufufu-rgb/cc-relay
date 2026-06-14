'use strict';
// Stop hook (fires after each turn). Reads the transcript path from stdin, scans the tail,
// and if it sees a rate-limit/auth error, calls rotate to mark the current account so the
// next launch round-robins past it. Always exits 0 silently — never disrupts the host CLI.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readCurrent, rotateLease } = require('./relay');
const { classifyRateLimit } = require('./claude');

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function latestTranscript() {
  const root = path.join(os.homedir(), '.claude', 'projects');
  let newest = null, mt = 0;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) {
        try { const s = fs.statSync(p); if (s.mtimeMs > mt) { mt = s.mtimeMs; newest = p; } } catch {}
      }
    }
  };
  walk(root);
  return newest;
}

function tail(file, n) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.slice(-n).join('\n');
  } catch { return ''; }
}

async function runHook() {
  try {
    const stdin = readStdin();
    let tp = null;
    if (stdin) { try { tp = JSON.parse(stdin).transcript_path; } catch {} }
    if (!tp || !fs.existsSync(tp)) tp = latestTranscript();
    if (!tp || !fs.existsSync(tp)) return process.exit(0);
    const t = tail(tp, 8).toLowerCase();
    if (!/error|is_error|isapierror/.test(t)) return process.exit(0); // require error context to avoid false marks
    const reason = classifyRateLimit(t);
    if (reason) {
      const cur = readCurrent();
      if (cur) { try { await rotateLease(cur, reason); } catch {} }
    }
  } catch {}
  process.exit(0);
}

module.exports = { runHook };
