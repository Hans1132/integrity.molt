'use strict';
// AutoPilot co-signing rules — loaded from environment variables.
// All monetary values in USDC (float).

module.exports = {
  enabled: process.env.AUTOPILOT_ENABLED !== 'false',  // default: true

  // Per-transaction limit (USDC)
  maxTxUsdc: parseFloat(process.env.AUTOPILOT_MAX_TX_USDC || '5.0'),

  // Daily spending limit per agent mint (USDC)
  maxDailyUsdc: parseFloat(process.env.AUTOPILOT_MAX_DAILY_USDC || '50.0'),

  // Skills allowed for auto-sign (null = all skills allowed)
  allowedSkills: process.env.AUTOPILOT_ALLOWED_SKILLS
    ? process.env.AUTOPILOT_ALLOWED_SKILLS.split(',').map(s => s.trim())
    : null,  // null = all skills

  // Recipient addresses permanently blocked (comma-separated in env)
  blacklistedRecipients: process.env.AUTOPILOT_BLACKLIST
    ? process.env.AUTOPILOT_BLACKLIST.split(',').map(s => s.trim())
    : [],
};
