'use strict';

// src/lib/url-validation.js — sdílená SSRF validace
// Importováno z handler.js (s testBypass pro historické integration testy)
// a z src/enrichment/metaplex-agent.js (bez bypass, vždy enforce).

const _SSRF_DENY = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.0\.0\.0|0177\.|2130706433$)/i;
const _SSRF_IPV6 = /^(::1$|::$|0:0:0:0:0:0:0:1$|::ffff:|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:)/i;

/**
 * validateUrl — vrátí null pokud je URL safe, jinak error string.
 * @param {string} url
 * @param {{ testBypass?: boolean }} opts — testBypass:true přeskočí _SSRF_DENY (ne IPv6)
 */
function validateUrl(url, { testBypass = false } = {}) {
  if (!url) return null;
  let u;
  try { u = new URL(url); } catch { return 'invalid URL'; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'protocol must be http or https';
  const hostname = u.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (!testBypass && _SSRF_DENY.test(hostname)) return `SSRF deny-list: ${hostname}`;
  if (_SSRF_IPV6.test(hostname)) return `SSRF deny-list IPv6: ${hostname}`;
  return null;
}

module.exports = { validateUrl };
