'use strict';

// Loopback HTTP client — wraps fetch calls to integrity.molt backend on 127.0.0.1.
// Reads INTEGRITY_MOLT_BASE_URL at call time (not require time) so tests can override it.

function baseUrl() {
  return (process.env.INTEGRITY_MOLT_BASE_URL || 'http://127.0.0.1:3402').replace(/\/$/, '');
}

async function get(path, timeoutMs = 30_000) {
  const res = await fetch(`${baseUrl()}${path}`, {
    headers: { 'X-MCP-Caller': '1' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json?.error || json?.message || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

async function post(path, body, timeoutMs = 30_000) {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-MCP-Caller': '1' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json?.error || json?.message || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

module.exports = { get, post };
