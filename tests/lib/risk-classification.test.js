'use strict';
// tests/lib/risk-classification.test.js — IRIS v2.0 shared lib unit tests
//
// Targets `src/lib/risk-classification.js` (introduced by backend Phase 2A Task 5,
// see docs/superpowers/specs/2026-05-19-iris-v2-amendment-q3-3tier.md §6.1).
//
// Until backend's commit lands on main this test FAILS with
// "Cannot find module '../../src/lib/risk-classification'" — that is the
// documented RED state for qa Phase 2B (CLAUDE.md §6 plan-before-code workflow,
// implementation plan Task 17 step 2).

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyRisk, isElevatedRisk } = require('../../src/lib/risk-classification');

test('classifyRisk: boundary 39/40 (safe → caution)', () => {
  assert.equal(classifyRisk(39), 'safe');
  assert.equal(classifyRisk(40), 'caution');
});

test('classifyRisk: boundary 69/70 (caution → danger)', () => {
  assert.equal(classifyRisk(69), 'caution');
  assert.equal(classifyRisk(70), 'danger');
});

test('classifyRisk: null/undefined/NaN → unknown', () => {
  assert.equal(classifyRisk(null), 'unknown');
  assert.equal(classifyRisk(undefined), 'unknown');
  assert.equal(classifyRisk(NaN), 'unknown');
});

test('classifyRisk: extremes 0 and 100', () => {
  assert.equal(classifyRisk(0), 'safe');
  assert.equal(classifyRisk(100), 'danger');
});

test('classifyRisk: 5pdyeWSC reference scores (51 and 64) → caution', () => {
  // Amendment v3 §3.3: 5pdyeWSC v2 score under external_oracle_floor reaches 64;
  // historical v1 score was 51 (per memory.md 2026-05-09). Both values map to
  // `caution` under preserved 40/70 thresholds (amendment v2 §1.3).
  assert.equal(classifyRisk(51), 'caution');
  assert.equal(classifyRisk(64), 'caution');
});

test('isElevatedRisk: only caution + danger are elevated', () => {
  assert.equal(isElevatedRisk('safe'), false);
  assert.equal(isElevatedRisk('caution'), true);
  assert.equal(isElevatedRisk('danger'), true);
  assert.equal(isElevatedRisk('unknown'), false);
});
