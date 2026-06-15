'use strict';
// Local loopback egress proxy. claude → http://127.0.0.1:<port> (this) → user's static
// upstream proxy (CONNECT tunnel) → api.anthropic.com. We parse Anthropic usage off
// /v1/messages 2xx responses and fire-and-forget report it to the control plane, credited
// to *this device's own* account (Authorization: Bearer <device-key>).
//
// HIGH-4: if no upstream proxy is configured we REFUSE to start. Direct-connecting would
// make the token egress from this raw machine/ECS IP — an egress-IP drift that is a ban
// signal for the account pool. The caller must configure a static upstream proxy first.
//
// Zero npm deps: the CONNECT tunnel is hand-written with net + tls.
const http = require('http');
const net = require('net');
const tls = require('tls');
const url = require('url');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const USAGE_LOG = path.join(process.env.CC_RELAY_DIR ? path.resolve(process.env.CC_RELAY_DIR) : path.join(os.homedir(), '.cc-relay'), 'usage.log');
const MAX_TEE = 8 * 1024 * 1024; // 8MB cap on buffered response body for usage parsing

// ── usage parsing (ported verbatim from central anthropic_proxy.js) ──────────
function scanUsage(text, u) {
  let m;
  if (u.input == null && (m = text.match(/"input_tokens":\s*(\d+)/))) u.input = +m[1];
  const outs = [...text.matchAll(/"output_tokens":\s*(\d+)/g)];
  if (outs.length) u.output = +outs[outs.length - 1][1];
  if (u.cw == null && (m = text.match(/"cache_creation_input_tokens":\s*(\d+)/))) u.cw = +m[1];
  if (u.cr == null && (m = text.match(/"cache_read_input_tokens":\s*(\d+)/))) u.cr = +m[1];
  if (!u.model && (m = text.match(/"model":\s*"([^"]+)"/))) u.model = m[1];
}

function decode(buf, enc) {
  try {
    enc = (enc || '').toLowerCase();
    if (enc.includes('br')) return zlib.brotliDecompressSync(buf).toString('utf8');
    if (enc.includes('gzip')) return zlib.gunzipSync(buf).toString('utf8');
    if (enc.includes('deflate')) return zlib.inflateSync(buf).toString('utf8');
  } catch (_) {}
  return buf.toString('utf8');
}

// ── usage report (fire-and-forget, device-key auth) ──────────────────────────
// Credits ONLY this device's own account (the backend ties the dev- key to its owner).
// parseWindow extracts the account-level 5h/7d rolling-quota snapshot from Anthropic's
// response headers (lowercased by Node). Same value regardless of which user made the
// request — it's the shared subscription's quota. lease.account_id ties it to the account.
function parseWindow(lease, headers) {
  headers = headers || {};
  const f = (k) => { const v = parseFloat(headers[k]); return isFinite(v) ? v : 0; };
  const i = (k) => { const v = parseInt(headers[k], 10); return isFinite(v) ? v : 0; };
  return {
    account_id: (lease && lease.account_id) || '',
    u5h: f('anthropic-ratelimit-unified-5h-utilization'),
    r5h: i('anthropic-ratelimit-unified-5h-reset'),
    u7d: f('anthropic-ratelimit-unified-7d-utilization'),
    r7d: i('anthropic-ratelimit-unified-7d-reset'),
  };
}

function reportUsage(deviceKey, tokenTail, u, controlPlaneUrl, extra) {
  // local trail first — always useful even if the control-plane POST fails / is offline.
  try {
    fs.appendFile(USAGE_LOG, JSON.stringify({
      t: new Date().toISOString(), acct: tokenTail, model: u.model,
      in: u.input || 0, out: u.output || 0, cw: u.cw || 0, cr: u.cr || 0,
    }) + '\n', () => {});
  } catch (_) {}
  if (!deviceKey || !tokenTail || !controlPlaneUrl) return;
  try {
    const body = JSON.stringify(Object.assign({
      account: tokenTail, model: u.model || '', in: u.input || 0, out: u.output || 0,
      cw: u.cw || 0, cr: u.cr || 0, ts: Math.floor(Date.now() / 1000),
    }, extra || {}));
    const cp = new url.URL(controlPlaneUrl);
    const isHttps = cp.protocol === 'https:';
    const lib = isHttps ? https : http;
    const opts = {
      host: cp.hostname,
      port: cp.port || (isHttps ? 443 : 80),
      path: (cp.pathname.replace(/\/$/, '')) + '/api/v1/relay/usage',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': 'Bearer ' + deviceKey,
      },
    };
    if (isHttps) opts.servername = cp.hostname;
    const rq = lib.request(opts, (rr) => rr.resume());
    rq.on('error', () => {});
    rq.write(body);
    rq.end();
  } catch (_) {}
}

// ── manual CONNECT tunnel through the upstream static proxy ──────────────────
// Opens a net.Socket to the upstream proxy, sends CONNECT <host>:<port>, waits for the
// 2xx, then TLS-wraps the raw socket. cb(err, tlsSocket).
function connectThroughUpstream(upstream, targetHost, targetPort, cb) {
  let pu;
  try { pu = new url.URL(upstream); } catch (e) { return cb(e); }
  const proxyPort = pu.port ? +pu.port : (pu.protocol === 'https:' ? 443 : 80);
  let done = false;
  const finish = (err, sock) => { if (done) return; done = true; cb(err, sock); };

  // The hop to the proxy itself: TLS if the proxy URL is https://, plain TCP otherwise.
  const rawConnect = (onReady) => {
    if (pu.protocol === 'https:') {
      const s = tls.connect({ host: pu.hostname, port: proxyPort, servername: pu.hostname }, () => onReady(s));
      return s;
    }
    const s = net.connect({ host: pu.hostname, port: proxyPort }, () => onReady(s));
    return s;
  };

  const sock = rawConnect((s) => {
    const hostHdr = targetHost + ':' + targetPort;
    let req = 'CONNECT ' + hostHdr + ' HTTP/1.1\r\nHost: ' + hostHdr + '\r\n';
    if (pu.username) {
      const cred = Buffer.from(decodeURIComponent(pu.username) + ':' + decodeURIComponent(pu.password || '')).toString('base64');
      req += 'Proxy-Authorization: Basic ' + cred + '\r\n';
    }
    req += 'Proxy-Connection: keep-alive\r\n\r\n';
    s.write(req);
  });

  let buf = Buffer.alloc(0);
  const onData = (d) => {
    buf = Buffer.concat([buf, d]);
    const idx = buf.indexOf('\r\n\r\n');
    if (idx === -1) {
      if (buf.length > 65536) { sock.destroy(); finish(new Error('CONNECT response too large')); }
      return;
    }
    sock.removeListener('data', onData);
    const statusLine = buf.slice(0, buf.indexOf('\r\n')).toString('utf8');
    const m = statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})/);
    if (!m || m[1][0] !== '2') {
      sock.destroy();
      return finish(new Error('upstream CONNECT failed: ' + statusLine));
    }
    // Any bytes the proxy sent after the CONNECT response belong to the raw socket's
    // stream (the start of the TLS handshake response). Push them back onto the raw
    // socket BEFORE tls.connect wraps it so the TLS layer sees them. (In practice the
    // proxy waits for the client ClientHello, so leftover is almost always empty.)
    const leftover = buf.slice(idx + 4);
    if (leftover.length && typeof sock.unshift === 'function') sock.unshift(leftover);
    const tlsSock = tls.connect({ socket: sock, servername: targetHost }, () => finish(null, tlsSock));
    tlsSock.on('error', (e) => finish(e));
  };
  sock.on('data', onData);
  sock.on('error', (e) => finish(e));
  sock.on('close', () => finish(new Error('upstream socket closed before CONNECT completed')));
}

// ── the egress proxy server ───────────────────────────────────────────────────
function startEgressProxy(lease, upstreamProxy, controlPlaneUrl, deviceKey) {
  return new Promise((resolve, reject) => {
    if (!upstreamProxy || !String(upstreamProxy).trim()) {
      // HIGH-4: never silently direct-connect. Refuse to start.
      return reject(new Error('no upstream proxy configured — run: cc-relay set-upstream-proxy <url> (refusing to direct-connect: would drift the egress IP and signal a banned account)'));
    }
    upstreamProxy = String(upstreamProxy).trim();

    // Resolve the upstream Anthropic host from the lease (default api.anthropic.com:443).
    let targetHost = 'api.anthropic.com';
    let targetPort = 443;
    if (lease && lease.base_url) {
      try {
        const bu = new url.URL(lease.base_url);
        if (bu.hostname) targetHost = bu.hostname;
        targetPort = bu.port ? +bu.port : (bu.protocol === 'http:' ? 80 : 443);
      } catch (_) {}
    }
    const tokenTail = lease && lease.oauth_token ? String(lease.oauth_token).slice(-8) : '';

    const server = http.createServer((req, res) => {
      connectThroughUpstream(upstreamProxy, targetHost, targetPort, (err, tlsSock) => {
        if (err || !tlsSock) {
          try { res.writeHead(502, { 'Content-Type': 'text/plain' }); } catch (_) {}
          try { res.end('cc-relay egress: upstream connect failed: ' + (err && err.message)); } catch (_) {}
          return;
        }
        // Forward the request to Anthropic over the tunnel using http.request on the
        // already-established TLS socket (createConnection returns our tunneled socket).
        const h = Object.assign({}, req.headers);
        h['host'] = targetHost;
        delete h['connection'];
        delete h['proxy-connection'];
        const upReq = https.request({
          host: targetHost,
          port: targetPort,
          path: req.url,
          method: req.method,
          headers: h,
          servername: targetHost,
          createConnection: () => tlsSock,
        }, (r) => {
          try { res.writeHead(r.statusCode, r.headers); } catch (_) {}
          const win = parseWindow(lease, r.headers);
          const isMsg = /\/v1\/messages/.test(req.url) && r.statusCode >= 200 && r.statusCode < 300;
          if (isMsg) {
            // Tee: capture (capped) for usage parsing AND pipe through byte-for-byte (SSE-safe).
            const chunks = [];
            let total = 0, over = false;
            r.on('data', (d) => {
              if (!over) {
                chunks.push(d);
                total += d.length;
                if (total > MAX_TEE) { over = true; chunks.length = 0; }
              }
            });
            r.on('end', () => {
              try {
                if (over) return;
                const text = decode(Buffer.concat(chunks), r.headers['content-encoding']);
                const u = { input: null, output: null, cw: null, cr: null, model: null };
                scanUsage(text, u);
                if (u.input != null || u.output != null) {
                  reportUsage(deviceKey, tokenTail, u, controlPlaneUrl, win);
                }
              } catch (_) {}
            });
          }
          r.pipe(res);
        });
        upReq.on('error', (e) => {
          try { res.writeHead(502, { 'Content-Type': 'text/plain' }); } catch (_) {}
          try { res.end('cc-relay egress: forward error: ' + e.message); } catch (_) {}
        });
        req.pipe(upReq);
      });
    });

    server.on('error', (e) => reject(e));
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const shutdown = () => new Promise((res) => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; res(); } };
        try { server.close(done); } catch (_) { done(); }
        // close() waits for live connections to drain; guard against a hung keep-alive
        // so a CLI teardown never blocks forever.
        const t = setTimeout(done, 1000);
        if (t.unref) t.unref();
      });
      resolve({ port, shutdown });
    });
  });
}

// ── data-plane tee proxy (no upstream proxy configured) ──────────────────────
// claude → http://127.0.0.1:<port> (this) → lease.base_url (central relay data
// plane, e.g. https://api.wengui.xyz[/n/<node>]) with the X-Relay-Key gate header
// injected. The data plane forwards through the owner's residential egress node,
// so the token never exits THIS raw machine's IP (not a direct-connect/IP-drift
// risk). We tee /v1/messages 2xx to parse usage + model and report it (device-key
// auth → per-user × per-model billing). Simpler than the egress proxy: a normal
// HTTPS forward, no CONNECT-through-upstream.
function startDataPlaneProxy(lease, controlPlaneUrl, deviceKey) {
  return new Promise((resolve, reject) => {
    let targetHost = 'api.anthropic.com', targetPort = 443, basePath = '';
    try {
      const bu = new url.URL(lease.base_url);
      if (bu.hostname) targetHost = bu.hostname;
      targetPort = bu.port ? +bu.port : (bu.protocol === 'http:' ? 80 : 443);
      basePath = bu.pathname.replace(/\/$/, ''); // keep /n/<id> prefix if present, drop trailing slash
    } catch (_) {}
    const lib = targetPort === 80 ? http : https;
    const relayKey = (lease && lease.relay_key) || '';
    const tokenTail = lease && lease.oauth_token ? String(lease.oauth_token).slice(-8) : '';

    const server = http.createServer((req, res) => {
      const h = Object.assign({}, req.headers);
      h['host'] = targetHost;
      if (relayKey) h['x-relay-key'] = relayKey;
      delete h['connection'];
      delete h['proxy-connection'];
      const upReq = lib.request({
        host: targetHost, port: targetPort, path: basePath + req.url,
        method: req.method, headers: h, servername: targetHost,
      }, (r) => {
        try { res.writeHead(r.statusCode, r.headers); } catch (_) {}
        const win = parseWindow(lease, r.headers);
        const isMsg = /\/v1\/messages/.test(req.url) && r.statusCode >= 200 && r.statusCode < 300;
        if (isMsg) {
          const chunks = []; let total = 0, over = false;
          r.on('data', (d) => {
            if (!over) { chunks.push(d); total += d.length; if (total > MAX_TEE) { over = true; chunks.length = 0; } }
          });
          r.on('end', () => {
            try {
              if (over) return;
              const text = decode(Buffer.concat(chunks), r.headers['content-encoding']);
              const u = { input: null, output: null, cw: null, cr: null, model: null };
              scanUsage(text, u);
              if (u.input != null || u.output != null) reportUsage(deviceKey, tokenTail, u, controlPlaneUrl, win);
            } catch (_) {}
          });
        }
        r.pipe(res);
      });
      upReq.on('error', (e) => {
        try { res.writeHead(502, { 'Content-Type': 'text/plain' }); } catch (_) {}
        try { res.end('cc-relay data-plane: forward error: ' + e.message); } catch (_) {}
      });
      req.pipe(upReq);
    });

    server.on('error', (e) => reject(e));
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const shutdown = () => new Promise((res) => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; res(); } };
        try { server.close(done); } catch (_) { done(); }
        const t = setTimeout(done, 1000);
        if (t.unref) t.unref();
      });
      resolve({ port, shutdown });
    });
  });
}

module.exports = { startEgressProxy, startDataPlaneProxy, scanUsage, decode, reportUsage, parseWindow, connectThroughUpstream };
