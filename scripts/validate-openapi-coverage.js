#!/usr/bin/env node
'use strict';
/**
 * scripts/validate-openapi-coverage.js — OpenAPI coverage drift detector.
 *
 * Verifies that:
 *   1. Every pricingKey in endpoint-spec.js resolves in config/pricing.js
 *   2. Every entry in ENDPOINT_SPEC produces a distinct path in the generated OpenAPI
 *   3. Every key in PRICING has at least one entry in ENDPOINT_SPEC (warns on orphans)
 *
 * Exit code 0 = no drift.
 * Exit code 1 = coverage drift detected — fix endpoint-spec.js or pricing.js.
 *
 * Run:
 *   node scripts/validate-openapi-coverage.js
 *   npm run validate:openapi
 */

// Use a dummy ATA for validation — we only care about structural coverage, not the address value.
const DUMMY_ATA = 'DummyATAforValidation11111111111111111111111';

const { PRICING, PRICING_DISPLAY } = require('../config/pricing');
const { ENDPOINT_SPEC }            = require('../src/docs/endpoint-spec');
const { generateOpenApi }          = require('../src/docs/generate-openapi');

let errors  = 0;
let warnings = 0;

function fail(msg) {
  console.error(`[FAIL] ${msg}`);
  errors++;
}

function warn(msg) {
  console.warn(`[WARN] ${msg}`);
  warnings++;
}

function pass(msg) {
  console.log(`[OK]   ${msg}`);
}

// ── 1. Check all pricingKeys in ENDPOINT_SPEC resolve ────────────────────────
console.log('\n=== 1. Pricing key resolution ===');
const specKeys = new Set();
for (const spec of ENDPOINT_SPEC) {
  specKeys.add(spec.pricingKey);
  if (PRICING[spec.pricingKey] === undefined) {
    fail(`endpoint-spec.js entry "${spec.method} ${spec.path}" has pricingKey "${spec.pricingKey}" which is NOT in config/pricing.js`);
  } else {
    pass(`${spec.method.padEnd(4)} ${spec.path.padEnd(40)} → ${spec.pricingKey} = ${PRICING_DISPLAY[spec.pricingKey]}`);
  }
}

// ── 2. Check generated OpenAPI contains every ENDPOINT_SPEC path ─────────────
console.log('\n=== 2. OpenAPI path coverage ===');
let spec;
try {
  spec = generateOpenApi(DUMMY_ATA);
} catch (e) {
  fail(`generateOpenApi() threw: ${e.message}`);
  process.exit(1);
}

for (const endpoint of ENDPOINT_SPEC) {
  const openApiPath = endpoint.path;
  if (!spec.paths[openApiPath]) {
    fail(`Path "${openApiPath}" from endpoint-spec.js is MISSING from generated OpenAPI paths`);
  } else {
    const method = endpoint.method.toLowerCase();
    if (!spec.paths[openApiPath][method]) {
      fail(`Method ${endpoint.method} for path "${openApiPath}" is MISSING from generated OpenAPI`);
    } else {
      pass(`${endpoint.method.padEnd(4)} ${openApiPath}`);
    }
  }
}

// ── 3. Check for orphan pricing keys (in pricing.js but no endpoint spec) ────
console.log('\n=== 3. Orphan pricing keys ===');
for (const key of Object.keys(PRICING)) {
  if (!specKeys.has(key)) {
    warn(`PRICING key "${key}" (${PRICING_DISPLAY[key]}) has no entry in endpoint-spec.js — is this endpoint dead code?`);
  }
}

// ── 4. Check x-payment.payTo is populated for all paid paths ─────────────────
console.log('\n=== 4. x-payment.payTo populated ===');
for (const [path, item] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(item)) {
    if (op['x-payment']) {
      if (!op['x-payment'].payTo || op['x-payment'].payTo === '') {
        fail(`x-payment.payTo is empty for ${method.toUpperCase()} ${path}`);
      } else {
        pass(`${method.toUpperCase().padEnd(4)} ${path} → payTo=${op['x-payment'].payTo.slice(0, 20)}…`);
      }
    }
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n=== Summary ===');
if (errors > 0) {
  console.error(`\nFAILED — ${errors} error(s), ${warnings} warning(s). Fix endpoint-spec.js or config/pricing.js.\n`);
  process.exit(1);
} else {
  if (warnings > 0) {
    console.warn(`\nPASSED with ${warnings} warning(s). No drift detected in required coverage.\n`);
  } else {
    console.log(`\nPASSED — ${ENDPOINT_SPEC.length} endpoints covered, no drift detected.\n`);
  }
  process.exit(0);
}
