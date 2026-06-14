'use strict';
// Launch the target CLI. Interactive mode uses stdio:'inherit' so the child inherits the
// real terminal handles (correct TTY on every platform). The -p one-shot mode pipes output
// (tee'd through) and, on a rate-limit, rotates accounts and retries.
const { spawn } = require('child_process');
const { getLease, rotateLease, readCurrent, writeCurrent, readDeviceKey } = require('./relay');
const { resolveRealClaude, classifyRateLimit } = require('./claude');
const { MAX_ROTATE, controlPlane, readUpstreamProxy } = require('./config');
const { startEgressProxy } = require('./egress');

// Point claude at the LOCAL egress proxy (which forwards to lease.base_url through the
// user's static upstream proxy and reports usage). We deliberately override the lease's
// base_url with 127.0.0.1:<port>. The X-Relay-Key custom header is dropped: Phase A goes
// straight to Anthropic via the user's own proxy, NOT via the central data plane, so the
// data-plane relay key is no longer meaningful here.
function leaseEnv(lease, port) {
  const env = Object.assign({}, process.env);
  env.CLAUDE_CODE_OAUTH_TOKEN = lease.oauth_token;
  env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:' + port;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  delete env.ANTHROPIC_CUSTOM_HEADERS; // not needed: local proxy → Anthropic direct (no central data plane)
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

  // HIGH-4: refuse to run without a static upstream proxy — direct-connecting would drift
  // the token's egress IP (a ban signal). Fail fast with the fix instruction.
  const upstreamProxy = readUpstreamProxy();
  if (!upstreamProxy) {
    console.error('[cc-relay] no upstream proxy configured — run: cc-relay set-upstream-proxy <url> first.\n' +
      '  (refusing to start: a direct connection would change the token egress IP and risk a ban.)');
    process.exit(1);
  }
  const cp = controlPlane();
  const deviceKey = readDeviceKey();

  let lease = await getLease();
  if (!lease) { console.error('[cc-relay] could not fetch token (not enrolled? network? revoked? pool exhausted?) — run: cc-relay enroll <code>'); process.exit(1); }
  writeCurrent(lease.account_id);

  const isOneShot = args.includes('-p') || args.includes('--print');
  if (!isOneShot) {
    // Interactive: hand the real terminal to the child. Rotation is handled by round-robin
    // (a fresh account each launch) plus the Stop hook marking exhausted accounts.
    const { port, shutdown } = await startEgressProxy(lease, upstreamProxy, cp, deviceKey);
    let code;
    try {
      code = await spawnInherit(claude, args, leaseEnv(lease, port));
    } finally {
      await shutdown();
    }
    process.exit(code);
  }

  // -p: capture output and, on a rate-limit, rotate + retry. Each lease gets its own egress
  // proxy (the proxy closes over the lease's token tail + base_url), so on rotation we tear
  // the proxy down before rotating and stand a fresh one up for the new lease — no port leak.
  let rot = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { port, shutdown } = await startEgressProxy(lease, upstreamProxy, cp, deviceKey);
    let code, text;
    try {
      ({ code, text } = await spawnCaptured(claude, args, leaseEnv(lease, port)));
    } finally {
      await shutdown();
    }
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
