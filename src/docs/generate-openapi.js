'use strict';
/**
 * src/docs/generate-openapi.js — Runtime OpenAPI 3.0.3 spec generator.
 *
 * Imports:
 *   - config/pricing.js        (prices — canonical source)
 *   - src/docs/endpoint-spec.js (path/method/schema table — canonical structure)
 *
 * Usage:
 *   const { generateOpenApi } = require('./src/docs/generate-openapi');
 *   res.json(generateOpenApi(USDC_ATA));
 *
 * The usdcAta parameter is the runtime-derived Associated Token Account address.
 * It is passed in rather than read from env so the generator remains pure and testable.
 */

const { PRICING, PRICING_DISPLAY } = require('../../config/pricing');
const { ENDPOINT_SPEC }            = require('./endpoint-spec');

/**
 * Build the x-payment extension object for one endpoint.
 */
function buildPayment(pricingKey, path, usdcAta) {
  const amount        = PRICING[pricingKey];
  const amountDisplay = PRICING_DISPLAY[pricingKey];
  if (amount === undefined) {
    throw new Error(`[generate-openapi] Unknown pricingKey "${pricingKey}" — add it to config/pricing.js`);
  }
  return {
    version:       1,
    scheme:        'exact',
    network:       'solana-mainnet',
    asset:         'USDC',
    amount,
    amountDisplay,
    payTo:         usdcAta,
    memo:          path
  };
}

/**
 * Build a standard JSON-body requestBody object from a schema descriptor.
 */
function buildRequestBody(schema) {
  if (!schema) return undefined;
  return {
    required: true,
    content: {
      'application/json': { schema }
    }
  };
}

/**
 * Build the parameters array (path params + query params) for a spec entry.
 */
function buildParameters(spec) {
  const params = [];
  if (spec.pathParams)  params.push(...spec.pathParams);
  if (spec.queryParams) params.push(...spec.queryParams);
  return params.length ? params : undefined;
}

/**
 * Convert an endpoint spec entry into an OpenAPI path item value.
 */
function buildPathItem(spec, usdcAta) {
  const methodKey = spec.method.toLowerCase();
  const operation = {
    summary:     `${spec.summary} (${PRICING_DISPLAY[spec.pricingKey]})`,
    description: spec.description,
    tags:        spec.tags,
    responses: {
      '200': { description: spec.responseDescription },
      '402': { description: `Payment required (${PRICING_DISPLAY[spec.pricingKey]} via x402)` }
    },
    'x-payment': buildPayment(spec.pricingKey, spec.path.replace(/{/g, ':').replace(/}/g, ''), usdcAta)
  };

  const params = buildParameters(spec);
  if (params)               operation.parameters  = params;

  const body = buildRequestBody(spec.requestSchema);
  if (body)                 operation.requestBody = body;

  return { [methodKey]: operation };
}

/**
 * Generate the full OpenAPI 3.0.3 document.
 *
 * @param {string} usdcAta  Runtime USDC Associated Token Account address.
 * @returns {object}        Plain JS object — call res.json() or JSON.stringify() on it.
 */
function generateOpenApi(usdcAta) {
  if (!usdcAta) {
    throw new Error('[generate-openapi] usdcAta is required — pass the runtime USDC ATA address');
  }

  const paths = {};

  for (const spec of ENDPOINT_SPEC) {
    // OpenAPI uses {param} syntax; Express uses :param — spec uses {param}.
    const openApiPath = spec.path;
    if (!paths[openApiPath]) {
      paths[openApiPath] = {};
    }
    Object.assign(paths[openApiPath], buildPathItem(spec, usdcAta));
  }

  // Add non-paid discovery/health endpoints
  paths['/services'] = {
    get: {
      summary:     'Service discovery (free)',
      description: 'Lists all available services, pricing, and payment details.',
      tags:        ['meta'],
      responses: { '200': { description: 'Service list' } }
    }
  };
  paths['/health'] = {
    get: {
      summary:     'Health check (free)',
      description: 'Returns service status.',
      tags:        ['meta'],
      responses: { '200': { description: 'Status OK' } }
    }
  };

  return {
    openapi: '3.0.3',
    info: {
      title:       'integrity.molt Security Scanner',
      description: 'AI-powered Solana security scanner. All reports Ed25519 cryptographically signed. Pay per scan via x402 protocol.',
      version:     '1.0.0',
      contact: {
        url: 'https://t.me/intmolt_bot'
      }
    },
    servers: [
      { url: 'https://intmolt.org' }
    ],
    paths
  };
}

module.exports = { generateOpenApi };
