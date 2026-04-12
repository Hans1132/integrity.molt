#!/usr/bin/env node
// tests/security/no-secrets.js — kontrola že v kódu nejsou hardcoded secrety
// Scope: src/ adresář a server.js

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../');
const SCAN_TARGETS = [
  path.join(ROOT, 'src'),
  path.join(ROOT, 'server.js')
];

const SECRET_PATTERNS = [
  /PRIVATE_KEY/,
  /BEGIN.*PRIVATE/,
  /sk_live/,
  /sk_test/
];

function getJsFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const stat = fs.statSync(dir);
  if (stat.isFile()) {
    if (dir.endsWith('.js')) results.push(dir);
    return results;
  }
  const entries = fs.readdirSync(dir);
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const s = fs.statSync(full);
    if (s.isDirectory()) {
      results.push(...getJsFiles(full));
    } else if (entry.endsWith('.js')) {
      results.push(full);
    }
  }
  return results;
}

const DATE = new Date().toISOString().slice(0, 10);
let foundSecrets = [];

for (const target of SCAN_TARGETS) {
  const files = getJsFiles(target);
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, idx) => {
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(line)) {
          // Ignoruj komentáře a false positive (např. process.env.PRIVATE_KEY je OK)
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
          // process.env přístupy nejsou hardcoded secrety
          if (/process\.env\./.test(line)) continue;
          const rel = path.relative(ROOT, file);
          foundSecrets.push(rel + ':' + (idx + 1) + ': ' + trimmed.slice(0, 120));
        }
      }
    });
  }
}

console.log('');
console.log('Security scan [' + DATE + '] — no-secrets check');
console.log('Scope: src/, server.js');
console.log('');

if (foundSecrets.length > 0) {
  console.log('FAIL — hardcoded secrets found (' + foundSecrets.length + '):');
  foundSecrets.forEach((s) => console.log('  ' + s));
  console.log('');
  process.exit(1);
} else {
  console.log('PASS — no hardcoded secrets found');
  console.log('');
  process.exit(0);
}
