'use strict';

// Loopback HTTP client — wraps fetch calls to integrity.molt backend.
// Reads INTEGRITY_MOLT_BASE_URL at call time (not require time) so tests can override it.

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB — guards against OOM on large responses

function baseUrl() {
  return (process.env.INTEGRITY_MOLT_BASE_URL || 'https://intmolt.org').replace(/\/$/, '');
}

async function readBody(res) {
  const reader = res.body.getReader();
  let received = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > MAX_BODY_BYTES) {
        reader.cancel().catch(() => {});
        throw new Error(`Response too large (limit ${MAX_BODY_BYTES} bytes)`);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (err) {
    reader.cancel().catch(() => {});
    throw err;
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function parseResponse(res) {
  const text = await readBody(res);
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    // 2xx with non-JSON body is a security oracle data-integrity failure — never silently succeed.
    throw new Error(`Backend returned non-JSON (status ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const raw = json?.error || json?.message || `HTTP ${res.status}`;
    // Scrub 5xx internals — surface status only, not stack frames or paths.
    const msg = res.status >= 500 ? `backend error (HTTP ${res.status})` : String(raw).slice(0, 200);
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return json;
}

async function get(path, timeoutMs = 30_000) {
  const res = await fetch(`${baseUrl()}${path}`, {
    headers: { 'X-MCP-Caller': '1' }, // informational only — NOT used for auth decisions
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  return parseResponse(res);
}

async function post(path, body, timeoutMs = 30_000) {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-MCP-Caller': '1' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  return parseResponse(res);
}

module.exports = { get, post };
