'use strict';
// tests/a2a-handler.test.js — Integration testy pro src/a2a/handler.js
// Run: node tests/a2a-handler.test.js
//
// Architecture:
//   Mini-server (port 3402): stub /scan/iris and /scan/token endpoints
//   Main test server (port 13402): mounts handleA2ARequest at POST /a2a
//   Tests call POST http://127.0.0.1:13402/a2a with JSON-RPC envelopes

// Must be set BEFORE requiring handler.js so that:
//   PORT = 3402 → INTERNAL_BASE = http://127.0.0.1:3402 (mini-server)
process.env.SQLITE_DB_PATH = ':memory:';
process.env.SOLANA_WALLET_ADDRESS = 'TestWalletAddressForTestSuiteOnly';
process.env.PORT = '3402';  // handler reads this at require time

// Initialize DB schema before requiring any module that calls db.prepare() at load time.
// ottersec.js calls db.prepare('SELECT * FROM ottersec_verifications ...') at module-load,
// so initSchema() must run first to create that table in the :memory: DB.
const { initSchema } = require('../db');
initSchema();

const http   = require('http');
const assert = require('assert');

// ── helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Simple JSON HTTP POST helper using only the built-in http module.
 */
function httpPost(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = http.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(raw) });
        } catch {
          resolve({ statusCode: res.statusCode, body: raw });
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** Build a standard JSON-RPC 2.0 request envelope. */
function rpc(method, params, id) {
  return { jsonrpc: '2.0', method, params, id: id !== undefined ? id : 1 };
}

/** tasks/send envelope for quick_scan with a valid-looking address. */
function sendQuickScan(address, extra) {
  return rpc('tasks/send', {
    message: {
      role: 'user',
      parts: [{ type: 'text', text: address }],
    },
    metadata: { skill: 'quick_scan' },
    ...extra,
  });
}

/**
 * Read all SSE events from an in-flight http.request until the response ends
 * or timeoutMs elapses.
 */
function readSseEvents(req, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const collected = [];
    let buf = '';
    let currentEvent = null;
    let resRef = null;
    const timer = setTimeout(() => {
      resolve({ status: resRef ? resRef.statusCode : 0, headers: resRef ? resRef.headers : {}, events: collected });
    }, timeoutMs);
    req.on('response', res => {
      resRef = res;
      res.on('data', chunk => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ') && currentEvent) {
            try { collected.push({ event: currentEvent, data: JSON.parse(line.slice(6)) }); } catch { /* skip */ }
            currentEvent = null;
          }
        }
      });
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, headers: res.headers, events: collected }); });
      res.on('error', err => { clearTimeout(timer); reject(err); });
    });
    req.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

/**
 * Fire a JSON-RPC request expecting an SSE stream response.
 * port must be the TEST_PORT (13402), not MINI_PORT.
 */
function sseRpc(port, method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 99, method, params });
  const req = http.request({
    hostname: '127.0.0.1',
    port,
    path:     '/a2a',
    method:   'POST',
    headers:  {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  });
  req.write(body);
  req.end();
  return readSseEvents(req);
}

// ── test runner ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    failed++;
  }
}

// ── servers ───────────────────────────────────────────────────────────────────

const MINI_PORT = 3402;
const TEST_PORT = 13402;

let miniServer;
let testServer;

function startMiniServer() {
  return new Promise((resolve, reject) => {
    miniServer = http.createServer((req, res) => {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw); } catch { /* ignore */ }

        if (req.method === 'POST' && req.url === '/scan/iris') {
          const result = {
            status:  'ok',
            address: body.address,
            data:    { iris_score: 5, risk_level: 'low', risk_factors: [] },
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }

        if (req.method === 'POST' && req.url === '/scan/token') {
          const result = {
            status:  'ok',
            address: body.address,
            data:    { iris_score: 20, risk_level: 'low', risk_factors: ['new_token'] },
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }

        // 404 for anything else
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      });
    });

    miniServer.on('error', reject);
    miniServer.listen(MINI_PORT, '127.0.0.1', () => {
      console.log(`  [mini-server] listening on ${MINI_PORT}`);
      resolve();
    });
  });
}

function startTestServer(handleA2ARequest) {
  return new Promise((resolve, reject) => {
    testServer = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/a2a') {
        let raw = '';
        req.on('data', c => { raw += c; });
        req.on('end', () => {
          let body;
          try { body = JSON.parse(raw); } catch { body = null; }
          // Attach parsed body to req (handler reads req.body)
          req.body = body;

          // Add Express-like helpers so handleA2ARequest can call res.json() / res.status()
          let _statusCode = 200;
          res.status = function(code) { _statusCode = code; return res; };
          res.json   = function(obj) {
            const payload = JSON.stringify(obj);
            res.writeHead(_statusCode, { 'Content-Type': 'application/json' });
            res.end(payload);
          };

          handleA2ARequest(req, res);
        });
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    });

    testServer.on('error', reject);
    testServer.listen(TEST_PORT, '127.0.0.1', () => {
      console.log(`  [test-server] listening on ${TEST_PORT}`);
      resolve();
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(resolve);
  });
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\na2a-handler.test.js\n');

  // Stop production service if running so we can bind port 3402
  const { execSync } = require('child_process');
  let serviceWasActive = false;
  try {
    execSync('systemctl is-active --quiet integrity-x402.service', { stdio: 'ignore' });
    serviceWasActive = true;
    console.log('  [setup] stopping integrity-x402.service');
    execSync('systemctl stop integrity-x402.service', { stdio: 'ignore' });
    // Brief wait for port release
    await sleep(500);
  } catch { /* service not active or systemctl unavailable — ignore */ }

  try {
    // 1. Start mini-server on 3402 first
    await startMiniServer();

    // 2. Require handler AFTER mini-server is up (and PORT=3402 is set)
    //    Handler reads PORT at require time → INTERNAL_BASE = http://127.0.0.1:3402
    const { handleA2ARequest } = require('../src/a2a/handler');

    // 3. Start main test server on 13402
    await startTestServer(handleA2ARequest);

    // A valid-looking base58 address (44 chars)
    const VALID_ADDRESS = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

    // ── tasks/send ────────────────────────────────────────────────────────────

    await test('tasks/send quick_scan returns submitted state, pricing.type=free, task id present', async () => {
      const res = await httpPost(TEST_PORT, '/a2a', sendQuickScan(VALID_ADDRESS));
      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.body.result, 'Expected result field');
      assert.ok(res.body.result.id, 'Task id missing');
      assert.strictEqual(res.body.result.status?.state, 'submitted');
      assert.strictEqual(res.body.result.pricing?.type, 'free');
    });

    await test('tasks/send without message returns -32602', async () => {
      const res = await httpPost(TEST_PORT, '/a2a', rpc('tasks/send', { metadata: { skill: 'quick_scan' } }));
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.error?.code, -32602);
    });

    await test('tasks/send unknown skillId returns -32602', async () => {
      const res = await httpPost(TEST_PORT, '/a2a', rpc('tasks/send', {
        message: { role: 'user', parts: [{ type: 'text', text: VALID_ADDRESS }] },
        metadata: { skill: 'nonexistent_skill_xyz' },
      }));
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.error?.code, -32602);
    });

    await test('tasks/send too-short address (5 chars) in message parts returns -32602', async () => {
      // Address must be in message parts (not metadata.address) to trigger regex validation.
      // extractAddressFromMessage looks for [1-9A-HJ-NP-Za-km-z]{32,44} — 5 chars won't match.
      const res = await httpPost(TEST_PORT, '/a2a', rpc('tasks/send', {
        message: { role: 'user', parts: [{ type: 'text', text: 'ABCDE' }] },
        metadata: { skill: 'quick_scan' },  // no metadata.address intentionally
      }));
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.error?.code, -32602, `Expected -32602, got ${JSON.stringify(res.body.error)}`);
    });

    await test('tasks/send invalid callbackUrl returns -32602', async () => {
      const res = await httpPost(TEST_PORT, '/a2a', rpc('tasks/send', {
        message: { role: 'user', parts: [{ type: 'text', text: VALID_ADDRESS }] },
        metadata: { skill: 'quick_scan', callbackUrl: 'ftp://invalid-scheme.example.com' },
      }));
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.error?.code, -32602);
    });

    // ── tasks/get ─────────────────────────────────────────────────────────────

    await test('tasks/get after send + 200ms sleep returns completed task with artifacts', async () => {
      // Send a task
      const sendRes = await httpPost(TEST_PORT, '/a2a', sendQuickScan(VALID_ADDRESS));
      assert.strictEqual(sendRes.statusCode, 200);
      const taskId = sendRes.body.result?.id;
      assert.ok(taskId, 'Task id missing from send response');

      // Wait for async execution to complete
      await sleep(200);

      const getRes = await httpPost(TEST_PORT, '/a2a', rpc('tasks/get', { id: taskId }));
      assert.strictEqual(getRes.statusCode, 200);
      const task = getRes.body.result;
      assert.ok(task, 'Expected result field');
      assert.strictEqual(task.id, taskId);
      assert.strictEqual(task.status?.state, 'completed', `Expected completed, got ${task.status?.state}`);
      assert.ok(Array.isArray(task.artifacts) && task.artifacts.length > 0, 'Expected non-empty artifacts');
    });

    await test('tasks/get without id returns -32602', async () => {
      const res = await httpPost(TEST_PORT, '/a2a', rpc('tasks/get', {}));
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.error?.code, -32602);
    });

    await test('tasks/get nonexistent id returns -32001', async () => {
      const res = await httpPost(TEST_PORT, '/a2a', rpc('tasks/get', { id: 'nonexistent-task-id-000' }));
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.error?.code, -32001);
    });

    // ── tasks/cancel ──────────────────────────────────────────────────────────

    await test('tasks/cancel returns canceled state or -32002 (race condition OK)', async () => {
      const sendRes = await httpPost(TEST_PORT, '/a2a', sendQuickScan(VALID_ADDRESS));
      assert.strictEqual(sendRes.statusCode, 200);
      const taskId = sendRes.body.result?.id;
      assert.ok(taskId, 'Task id missing');

      // Cancel immediately — may race with setImmediate completing the task
      const cancelRes = await httpPost(TEST_PORT, '/a2a', rpc('tasks/cancel', { id: taskId }));
      assert.strictEqual(cancelRes.statusCode, 200);
      const body = cancelRes.body;
      const isCanceled = body.result?.status?.state === 'canceled';
      const isAlreadyDone = body.error?.code === -32002;
      assert.ok(
        isCanceled || isAlreadyDone,
        `Expected canceled or -32002, got: ${JSON.stringify(body)}`
      );
    });

    await test('tasks/cancel without id returns -32602', async () => {
      const res = await httpPost(TEST_PORT, '/a2a', rpc('tasks/cancel', {}));
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.error?.code, -32602);
    });

    await test('tasks/cancel nonexistent id returns -32001', async () => {
      const res = await httpPost(TEST_PORT, '/a2a', rpc('tasks/cancel', { id: 'nonexistent-cancel-id-000' }));
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.error?.code, -32001);
    });

    // ── general ───────────────────────────────────────────────────────────────

    await test('unknown method returns -32601', async () => {
      const res = await httpPost(TEST_PORT, '/a2a', rpc('tasks/unknown_method', {}));
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.error?.code, -32601);
    });

    await test('missing jsonrpc field returns HTTP 400', async () => {
      const res = await httpPost(TEST_PORT, '/a2a', { method: 'tasks/get', params: {}, id: 1 });
      assert.strictEqual(res.statusCode, 400, `Expected 400, got ${res.statusCode}`);
    });

    // ── tasks/sendSubscribe ───────────────────────────────────────────────────

    await test('tasks/sendSubscribe vrátí SSE stream s task_created + task_completed', async () => {
      const result = await sseRpc(TEST_PORT, 'tasks/sendSubscribe', {
        message: {
          role: 'user',
          parts: [{ type: 'text', text: VALID_ADDRESS }],
        },
        metadata: { skill: 'quick_scan' },
      });

      assert.ok(
        result.headers['content-type']?.includes('text/event-stream'),
        `Expected content-type: text/event-stream, got: ${result.headers['content-type']}`
      );

      const createdEv = result.events.find(e => e.event === 'task_created');
      assert.ok(createdEv, `task_created event missing. Events: ${JSON.stringify(result.events.map(e => e.event))}`);
      assert.ok(createdEv.data?.result?.id, `task_created result.id missing. data: ${JSON.stringify(createdEv.data)}`);
      assert.strictEqual(
        createdEv.data?.result?.status?.state,
        'submitted',
        `Expected submitted, got: ${createdEv.data?.result?.status?.state}`
      );

      const completedEv = result.events.find(e => e.event === 'task_completed');
      assert.ok(completedEv, `task_completed event missing. Events: ${JSON.stringify(result.events.map(e => e.event))}`);
      assert.ok(
        Array.isArray(completedEv.data?.result?.artifacts) && completedEv.data.result.artifacts.length > 0,
        `task_completed artifacts empty. data: ${JSON.stringify(completedEv.data)}`
      );
    });

    await test('tasks/sendSubscribe bez message vrátí SSE task_failed', async () => {
      const result = await sseRpc(TEST_PORT, 'tasks/sendSubscribe', {
        metadata: { skill: 'quick_scan' },
      });

      const failedEv = result.events.find(e => e.event === 'task_failed');
      assert.ok(failedEv, `task_failed event missing. Events: ${JSON.stringify(result.events.map(e => e.event))}`);
    });

  } finally {
    // Tear down test servers
    await stopServer(testServer);
    await stopServer(miniServer);

    // Restart production service if it was running before
    if (serviceWasActive) {
      try {
        console.log('  [teardown] restarting integrity-x402.service');
        execSync('systemctl start integrity-x402.service', { stdio: 'ignore' });
      } catch (e) {
        console.warn('  [teardown] could not restart service:', e.message);
      }
    }

    // ── summary ────────────────────────────────────────────────────────────────
    console.log(`\n  ${passed} passed, ${failed} failed`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
