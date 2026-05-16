'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');

// validateCallbackUrl je exportována z handler.js
const { validateCallbackUrl } = require('../../src/a2a/handler');

const BLOCKED = [
  'http://127.0.0.1/evil',
  'http://localhost/evil',
  'http://10.0.0.1/evil',
  'http://192.168.1.1/evil',
  'http://169.254.169.254/evil',       // AWS metadata
  'http://0.0.0.0/evil',               // nové
  'http://2130706433/evil',            // 127.0.0.1 decimal
  'http://0177.0.0.1/evil',            // 127.0.0.1 octal
  'http://[::1]/evil',                 // IPv6 loopback
  'http://[::ffff:127.0.0.1]/evil',    // IPv4-mapped IPv6
  'http://[fc00::1]/evil',             // IPv6 ULA private
  'http://[fd12:3456::1]/evil',        // IPv6 ULA private
  'http://127.1/evil',                 // short-form loopback (AW-C-01 ShieldFlow)
  'http://[::ffff:169.254.169.254]/evil', // IPv4-mapped IPv6 AWS metadata (AW-C-01)
];

const ALLOWED = [
  'https://webhook.site/abc123',
  'https://api.example.com/callback',
  'https://my-service.com/hook',
];

for (const url of BLOCKED) {
  test(`blokuje ${url}`, () => {
    process.env.NODE_ENV = 'production'; // disable test bypass
    const err = validateCallbackUrl(url);
    assert.ok(err, `${url} mělo být zablokováno, ale prošlo`);
    process.env.NODE_ENV = 'test';
  });
}

for (const url of ALLOWED) {
  test(`povoluje ${url}`, () => {
    const err = validateCallbackUrl(url);
    assert.equal(err, null, `${url} nemělo být zablokováno: ${err}`);
  });
}
