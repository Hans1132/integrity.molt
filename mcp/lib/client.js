'use strict';

// HTTP client for integrity.molt backend.
// Uses node:https instead of global fetch — avoids undici TLS quirks on Windows.
// M4: BASE_URL frozen at module-load time to prevent TOCTOU via env mutation mid-request.

const https = require('node:https');
const http = require('node:http');

const MAX_BODY_BYTES = 5 * 1024 * 1024;

const BASE_URL = (process.env.INTEGRITY_MOLT_BASE_URL || 'https://intmolt.org').replace(/\/$/, '');

function request(method, urlStr, bodyStr, timeoutMs) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlStr); } catch { return reject(new Error(`Invalid URL: ${urlStr}`)); }

    const lib = url.protocol === 'https:' ? https : http;
    const bodyBuf = bodyStr ? Buffer.from(bodyStr, 'utf8') : null;
    let settled = false;
    const finish = (err, val) => { if (!settled) { settled = true; err ? reject(err) : resolve(val); } };

    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        'X-MCP-Caller': '1',
        ...(bodyBuf ? { 'Content-Type': 'application/json', 'Content-Length': bodyBuf.length } : {}),
      },
    }, (res) => {
      // Mirror fetch redirect:'error' — never follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        return finish(new Error(`Unexpected redirect (HTTP ${res.statusCode})`));
      }

      const chunks = [];
      let received = 0;

      res.on('data', (chunk) => {
        received += chunk.length;
        if (received > MAX_BODY_BYTES) {
          res.destroy();
          return finish(new Error(`Response too large (limit ${MAX_BODY_BYTES} bytes)`));
        }
        chunks.push(chunk);
      });

      res.on('error', (err) => finish(err));

      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          if (res.statusCode >= 400) {
            const err = new Error(`HTTP ${res.statusCode}`);
            err.status = res.statusCode;
            return finish(err);
          }
          return finish(new Error(`Backend returned non-JSON (status ${res.statusCode}): ${text.slice(0, 200)}`));
        }
        if (res.statusCode >= 400) {
          const raw = json?.error || json?.message || `HTTP ${res.statusCode}`;
          const msg = res.statusCode >= 500 ? `backend error (HTTP ${res.statusCode})` : String(raw).slice(0, 200);
          const err = new Error(msg);
          err.status = res.statusCode;
          return finish(err);
        }
        finish(null, json);
      });
    });

    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Request timeout after ${timeoutMs}ms`)));
    req.on('error', (err) => finish(err));

    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

async function get(path, timeoutMs = 30_000) {
  return request('GET', `${BASE_URL}${path}`, null, timeoutMs);
}

async function post(path, body, timeoutMs = 30_000) {
  return request('POST', `${BASE_URL}${path}`, JSON.stringify(body), timeoutMs);
}

module.exports = { get, post };
