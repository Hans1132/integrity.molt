'use strict';
/**
 * tests/enrichment/token-extensions.test.js
 *
 * Unit tests for src/enrichment/token-extensions.js — Token-2022 extension parser.
 * Exercises parseTokenExtensionsFromBuffer() with hand-crafted mint-account
 * buffers, including the CRITICAL PermanentDelegate / HIGH TransferHook signals
 * and malformed / truncated TLV data (must not throw or read out of bounds).
 *
 * Pure / offline — no RPC. Run: node tests/enrichment/token-extensions.test.js
 */

const assert = require('assert');
const { parseTokenExtensionsFromBuffer } = require('../../src/enrichment/token-extensions');

const _bs58raw = require('bs58');
const bs58 = _bs58raw.default || _bs58raw;

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const BASE_SIZE = 82;
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

// Build a Token-2022 mint buffer: 82-byte base + 1-byte account_type + TLV exts.
// exts: array of { type:number, data:Buffer }
function buildMint(exts) {
  const head = Buffer.alloc(BASE_SIZE + 1);
  head[BASE_SIZE] = 1; // account_type = Mint
  const parts = [head];
  for (const e of exts) {
    const tlv = Buffer.alloc(4);
    tlv.writeUInt16LE(e.type, 0);
    tlv.writeUInt16LE(e.data.length, 2);
    parts.push(tlv, e.data);
  }
  return Buffer.concat(parts);
}

console.log('\n── Token-2022 Extension Parser Tests ──────────────────────────────────────────\n');

test('legacy SPL mint (<=82 bytes) is not flagged as Token-2022', () => {
  const buf = Buffer.alloc(82);
  const out = parseTokenExtensionsFromBuffer(buf);
  assert.strictEqual(out.is_token_2022, false);
  assert.deepStrictEqual(out.extensions, []);
  assert.deepStrictEqual(out.extension_names, []);
});

test('PermanentDelegate with real (non-zero) delegate → CRITICAL', () => {
  const delegate = Buffer.alloc(32, 0x05); // non-zero pubkey
  const out = parseTokenExtensionsFromBuffer(buildMint([{ type: 12, data: delegate }]));
  assert.strictEqual(out.is_token_2022, true);
  assert.strictEqual(out.has_critical, true, 'must flag critical');
  const ext = out.extensions.find(e => e.name === 'PermanentDelegate');
  assert.ok(ext, 'PermanentDelegate present');
  assert.strictEqual(ext.severity, 'critical');
  assert.strictEqual(ext.delegate_address, bs58.encode(delegate));
  assert.notStrictEqual(ext.delegate_address, SYSTEM_PROGRAM);
});

test('PermanentDelegate with all-zero (unset) delegate → downgraded to info', () => {
  const delegate = Buffer.alloc(32, 0x00); // SystemProgram = unset
  const out = parseTokenExtensionsFromBuffer(buildMint([{ type: 12, data: delegate }]));
  const ext = out.extensions.find(e => e.name === 'PermanentDelegate');
  assert.ok(ext);
  assert.strictEqual(ext.delegate_address, null, 'unset delegate must be null');
  assert.strictEqual(ext.severity, 'info');
  assert.strictEqual(out.has_critical, false, 'unset delegate is not critical');
});

test('TransferHook with active program → HIGH', () => {
  const data = Buffer.concat([Buffer.alloc(32, 0x07), Buffer.alloc(32, 0x09)]); // authority + program
  const out = parseTokenExtensionsFromBuffer(buildMint([{ type: 14, data }]));
  assert.strictEqual(out.has_high, true);
  const ext = out.extensions.find(e => e.name === 'TransferHook');
  assert.ok(ext);
  assert.strictEqual(ext.severity, 'high');
  assert.strictEqual(ext.hook_program_id, bs58.encode(Buffer.alloc(32, 0x09)));
});

test('TransferHook with unset (zero) program → downgraded to info', () => {
  const data = Buffer.concat([Buffer.alloc(32, 0x07), Buffer.alloc(32, 0x00)]);
  const out = parseTokenExtensionsFromBuffer(buildMint([{ type: 14, data }]));
  const ext = out.extensions.find(e => e.name === 'TransferHook');
  assert.ok(ext);
  assert.strictEqual(ext.hook_program_id, null);
  assert.strictEqual(ext.severity, 'info');
  assert.strictEqual(out.has_high, false);
});

test('DefaultAccountState byte 1 → frozen, byte 0 → initialized', () => {
  const frozen = parseTokenExtensionsFromBuffer(buildMint([{ type: 6, data: Buffer.from([1]) }]));
  assert.strictEqual(frozen.extensions[0].default_state, 'frozen');
  assert.strictEqual(frozen.extensions[0].severity, 'medium');

  const init = parseTokenExtensionsFromBuffer(buildMint([{ type: 6, data: Buffer.from([0]) }]));
  assert.strictEqual(init.extensions[0].default_state, 'initialized');
});

test('NonTransferable → info severity, not critical/high', () => {
  const out = parseTokenExtensionsFromBuffer(buildMint([{ type: 9, data: Buffer.alloc(0) }]));
  const ext = out.extensions.find(e => e.name === 'NonTransferable');
  assert.ok(ext);
  assert.strictEqual(ext.severity, 'info');
  assert.strictEqual(out.has_critical, false);
  assert.strictEqual(out.has_high, false);
});

test('multiple extensions parsed in order; mixed severities surface', () => {
  const out = parseTokenExtensionsFromBuffer(buildMint([
    { type: 9,  data: Buffer.alloc(0) },              // NonTransferable (info)
    { type: 12, data: Buffer.alloc(32, 0x05) },       // PermanentDelegate (critical)
  ]));
  assert.strictEqual(out.extensions.length, 2);
  assert.deepStrictEqual(out.extension_names, ['NonTransferable', 'PermanentDelegate']);
  assert.strictEqual(out.has_critical, true);
});

test('unknown extension type → Unknown(N), info severity, no crash', () => {
  const out = parseTokenExtensionsFromBuffer(buildMint([{ type: 99, data: Buffer.alloc(4) }]));
  const ext = out.extensions[0];
  assert.strictEqual(ext.name, 'Unknown(99)');
  assert.strictEqual(ext.severity, 'info');
});

test('extType 0 acts as padding terminator (stops parsing)', () => {
  // buffer is >82 so flagged token-2022, but first TLV type 0 breaks the loop
  const buf = buildMint([{ type: 0, data: Buffer.alloc(8) }]);
  const out = parseTokenExtensionsFromBuffer(buf);
  assert.strictEqual(out.is_token_2022, true);
  assert.deepStrictEqual(out.extensions, [], 'type 0 terminates parsing');
});

test('truncated TLV (declared length exceeds buffer) does not throw or over-read', () => {
  // Header claims a 200-byte PermanentDelegate but only 4 bytes follow.
  const head = Buffer.alloc(BASE_SIZE + 1);
  head[BASE_SIZE] = 1;
  const tlv = Buffer.alloc(4);
  tlv.writeUInt16LE(12, 0);
  tlv.writeUInt16LE(200, 2);  // lies about length
  const buf = Buffer.concat([head, tlv, Buffer.alloc(4, 0xff)]);
  let out;
  assert.doesNotThrow(() => { out = parseTokenExtensionsFromBuffer(buf); });
  assert.strictEqual(out.is_token_2022, true);
  // extLength(200) < 32? no — 200>=32 so it parses delegate from a short slice; must not throw
  assert.ok(Array.isArray(out.extensions));
});

test('garbage extension region does not throw', () => {
  const head = Buffer.alloc(BASE_SIZE + 1);
  head[BASE_SIZE] = 1;
  const buf = Buffer.concat([head, Buffer.alloc(64, 0xab)]);
  assert.doesNotThrow(() => parseTokenExtensionsFromBuffer(buf));
});

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
