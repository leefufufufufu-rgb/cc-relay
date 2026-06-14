'use strict';
// Launch the target CLI. Interactive mode uses stdio:'inherit' so the child inherits the
// real terminal handles (correct TTY on every platform). The -p one-shot mode pipes output
// (tee'd through) and, on a rate-limit, rotates accounts and retries.
const { spawn } = require('child_process');
const { getLease, rotateLease, readCurrent, writeCurrent } = require('./relay');
const { resolveRealClaude, classifyRateLimit } = require('./claude');
const { MAX_ROTATE } = require('./config');

function leaseEnv(lease) {
  const env = Object.assign({}, process.env);
  env.CLAUDE_CODE_OAUTH_TOKEN = lease.oauth_token;
  env.ANTHROPIC_BASE_URL = lease.base_url;
  env.ANTHROPIC_CUSTOM_HEADERS = 'X-Relay-Key: ' + lease.relay_key;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  delete env.ANTHROPIC_API_KEY;    // never set these — they would disable the OAuth path
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

// Build (file, args) for spawn WITHOUT shell:true — shell:true on Windows concatenates
// (doesn't escape) args, which mangles quoted prompts, and emits a DEP0190 warning.
// The target is normally a native .exe/binary (spawned directly); a .cmd/.bat is run via
// cmd.exe /c with args passed as a proper array.
function launchSpec(claude, args) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(claude)) {
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', claude, ...args] };
  }
  return { file: claude, args };
}

function spawnInherit(claude, args, env) {
  const s = launchSpec(claude, args);
  return new Promise((resolve) => {
    const child = spawn(s.file, s.args, { stdio: 'inherit', env });
    child.on('exit', (code, sig) => resolve(sig ? 1 : (code == null ? 0 : code)));
    child.on('error', (e) => { console.error('[cc-relay] failed to launch target CLI: ' + e.message); resolve(127); });
  });
}

function spawnCaptured(claude, args, env) {
  const s = launchSpec(claude, args);
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(s.file, s.args, { stdio: ['inherit', 'pipe', 'pipe'], env });
    child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    child.stderr.on('data', (d) => { out += d; process.stderr.write(d); });
    child.on('exit', (code, sig) => resolve({ code: sig ? 1 : (code == null ? 0 : code), text: out }));
    child.on('error', (e) => resolve({ code: 127, text: String(e.message) }));
  });
}

async function run(args) {
  const claude = resolveRealClaude();
  if (!claude) { console.error('[cc-relay] target CLI not found (install Claude Code first).'); process.exit(127); }
  let lease = await getLease();
  if (!lease) { console.error('[cc-relay] could not fetch token (not enrolled? network? revoked? pool exhausted?) — run: cc-relay enroll <code>'); process.exit(1); }
  writeCurrent(lease.account_id);

  const isOneShot = args.includes('-p') || args.includes('--print');
  if (!isOneShot) {
    // Interactive: hand the real terminal to the child. Rotation is handled by round-robin
    // (a fresh account each launch) plus the Stop hook marking exhausted accounts.
    const code = await spawnInherit(claude, args, leaseEnv(lease));
    process.exit(code);
  }

  // -p: capture output and, on a rate-limit, rotate + retry.
  let rot = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { code, text } = await spawnCaptured(claude, args, leaseEnv(lease));
    const reason = code !== 0 ? classifyRateLimit(text) : null;
    if (reason && rot < MAX_ROTATE) {
      const cur = readCurrent() || lease.account_id;
      const next = await rotateLease(cur, reason);
      if (!next) { console.error('\n[cc-relay] current account ' + reason + ', no other account available.'); process.exit(code); }
      lease = next; writeCurrent(lease.account_id); rot++;
      console.error('\n[cc-relay] current account ' + reason + ' -> switched to next account (#' + rot + ')...');
      continue;
    }
    process.exit(code);
  }
}

module.exports = { run, leaseEnv };
