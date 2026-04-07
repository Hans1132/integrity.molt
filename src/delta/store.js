'use strict';
// src/delta/store.js — Snapshot storage for Verified Delta Reports
// Interface is intentionally thin to allow future migration to Postgres.
// Every snapshot: { version, address, scanType, timestamp, contentHash, data }

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const SNAPSHOTS_DIR = path.join(__dirname, '../../data/snapshots');

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function contentHash(data) {
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

// Convert ISO timestamp to a filename-safe string.
function tsToFilename(ts) {
  return ts.replace(/[:.]/g, '-');
}

/**
 * Save a snapshot for address+scanType.
 * @param {string} address
 * @param {string} scanType  e.g. 'token-audit', 'quick', 'evm-token'
 * @param {object} reportData  full scan result object
 * @returns {{ timestamp, contentHash, filename }}
 */
function saveSnapshot(address, scanType, reportData) {
  const dir = path.join(SNAPSHOTS_DIR, address);
  ensureDir(dir);

  const timestamp = new Date().toISOString();
  const hash      = contentHash(reportData);
  const snapshot  = { version: 1, address, scanType, timestamp, contentHash: hash, data: reportData };

  const filename = `${tsToFilename(timestamp)}_${scanType}.json`;
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(snapshot, null, 2), 'utf-8');
  console.log(`[delta/store] saved address=${address} type=${scanType} hash=${hash.slice(0, 12)}`);
  return { timestamp, contentHash: hash, filename };
}

/**
 * Return the most recent snapshot for address+scanType, or null.
 */
function getLatestSnapshot(address, scanType) {
  const dir = path.join(SNAPSHOTS_DIR, address);
  let files;
  try { files = fs.readdirSync(dir); } catch { return null; }

  const matching = files
    .filter(f => f.endsWith(`_${scanType}.json`))
    .sort()
    .reverse();

  if (!matching.length) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, matching[0]), 'utf-8'));
  } catch { return null; }
}

/**
 * Return a snapshot by address and ISO timestamp.
 * Matches on filename prefix derived from the timestamp.
 */
function getSnapshotByTimestamp(address, timestamp) {
  const dir = path.join(SNAPSHOTS_DIR, address);
  let files;
  try { files = fs.readdirSync(dir); } catch { return null; }

  const prefix = tsToFilename(timestamp);
  const match  = files.find(f => f.startsWith(prefix));
  if (!match) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, match), 'utf-8'));
  } catch { return null; }
}

/**
 * Return snapshot metadata list (no data field) for an address.
 * @param {string} address
 * @param {number} limit  default 10
 * @returns {Array<{ timestamp, scanType, contentHash, address }>}
 */
function getSnapshotHistory(address, limit = 10) {
  const dir = path.join(SNAPSHOTS_DIR, address);
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }

  return files
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit)
    .map(f => {
      try {
        const { version, timestamp, scanType, contentHash: h, address: a } =
          JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
        return { version, timestamp, scanType, contentHash: h, address: a };
      } catch { return null; }
    })
    .filter(Boolean);
}

module.exports = { saveSnapshot, getLatestSnapshot, getSnapshotByTimestamp, getSnapshotHistory };
