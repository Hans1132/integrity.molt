'use strict';
// tests/registry.test.js — Integration tests for frames.ag registry endpoints
// Tests /skill.md and /offer via live service on port 3402.
// If service is not running, tests are skipped (exit 0).
// Run: node tests/registry.test.js

const http = require('http');
const assert = require('assert');

const PORT = 3402;
const HOST = '127.0.0.1';

let passed = 0;
let failed = 0;

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: HOST, port: PORT, path, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => { resolve({ status: res.statusCode, headers: res.headers, body }); });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
  });
}

async function checkServiceRunning() {
  try {
    const res = await get('/health');
    return res.status === 200;
  } catch {
    return false;
  }
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

async function main() {
  const running = await checkServiceRunning();
  if (!running) {
    console.log('⚠️ SKIP: integrity-x402.service is not reachable on port 3402');
    process.exit(0);
  }

  console.log('\nregistry.test.js\n');

  // ── GET /skill.md ────────────────────────────────────────────────────────────

  await test('GET /skill.md returns 200', async () => {
    const res = await get('/skill.md');
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
  });

  await test('GET /skill.md Content-Type is text/markdown', async () => {
    const res = await get('/skill.md');
    const ct = res.headers['content-type'] || '';
    assert.ok(ct.startsWith('text/markdown'), `Expected text/markdown, got: ${ct}`);
  });

  await test('GET /skill.md contains YAML frontmatter with name: and description:', async () => {
    const res = await get('/skill.md');
    const body = res.body;
    assert.ok(body.startsWith('---'), 'Expected YAML frontmatter starting with ---');
    assert.ok(body.includes('name:'), 'Expected "name:" in frontmatter');
    assert.ok(body.includes('description:'), 'Expected "description:" in frontmatter');
  });

  await test('GET /skill.md contains ## Base URL section with intmolt.org', async () => {
    const res = await get('/skill.md');
    assert.ok(res.body.includes('## Base URL'), 'Expected "## Base URL" section');
    assert.ok(res.body.includes('intmolt.org'), 'Expected "intmolt.org" in Base URL section');
  });

  await test('GET /skill.md contains ## Endpoints section with /scan/v1/ and governance-change', async () => {
    const res = await get('/skill.md');
    assert.ok(res.body.includes('## Endpoints'), 'Expected "## Endpoints" section');
    assert.ok(res.body.includes('/scan/v1/'), 'Expected "/scan/v1/" in Endpoints section');
    assert.ok(
      res.body.includes('/monitor/v1/governance-change'),
      'Expected "/monitor/v1/governance-change" in Endpoints section'
    );
  });

  // ── GET /offer ───────────────────────────────────────────────────────────────

  await test('GET /offer returns 200', async () => {
    const res = await get('/offer');
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
  });

  await test('GET /offer Content-Type is application/json', async () => {
    const res = await get('/offer');
    const ct = res.headers['content-type'] || '';
    assert.ok(ct.includes('application/json'), `Expected application/json, got: ${ct}`);
  });

  await test('GET /offer has valid JSON with version and service (slug + title)', async () => {
    const res = await get('/offer');
    let data;
    try {
      data = JSON.parse(res.body);
    } catch (e) {
      throw new Error(`Response is not valid JSON: ${e.message}`);
    }
    assert.ok(data.version, 'Expected "version" field in response');
    assert.ok(data.service, 'Expected "service" field in response');
    assert.ok(data.service.slug, 'Expected "service.slug" field');
    assert.ok(data.service.title, 'Expected "service.title" field');
  });

  await test('GET /offer tools is an array with at least one tool (route + description)', async () => {
    const res = await get('/offer');
    const data = JSON.parse(res.body);
    assert.ok(Array.isArray(data.tools), 'Expected "tools" to be an array');
    assert.ok(data.tools.length > 0, 'Expected at least one tool in "tools" array');
    const first = data.tools[0];
    assert.ok(first.route, 'Expected first tool to have "route" field');
    assert.ok(first.description, 'Expected first tool to have "description" field');
  });

  // ── Summary ──────────────────────────────────────────────────────────────────

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
