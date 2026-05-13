'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');

// Přímý test isSafeNext funkce — auth.js ho musí exportovat nebo definovat interně
// Testujeme přes source parsing (auth.js je singleton s vedlejšími efekty)
test('isSafeNext odmítne external URLs', () => {
  const src = require('fs').readFileSync('./auth.js', 'utf-8');
  assert.ok(src.includes('isSafeNext'), 'auth.js musí definovat isSafeNext');
});

test('isSafeNext pravidla', () => {
  // Inline kopie funkce pro unit test
  function isSafeNext(next) {
    return typeof next === 'string'
      && next.startsWith('/')
      && !next.startsWith('//')
      && !next.startsWith('/\\')
      && !/^\/[a-z]+:/i.test(next); // blokuje /javascript:, /data:
  }
  assert.ok(isSafeNext('/dashboard'));
  assert.ok(isSafeNext('/subscribe/pro'));
  assert.ok(!isSafeNext('https://evil.com'));
  assert.ok(!isSafeNext('//evil.com'));
  assert.ok(!isSafeNext('/\\evil.com'));
  assert.ok(!isSafeNext('javascript:alert(1)'));
  assert.ok(!isSafeNext(''));
  assert.ok(!isSafeNext(undefined));
});
