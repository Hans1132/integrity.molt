'use strict';
// scripts/eval/lib/schema.js — validace gold entry + load anchoru. Čisté funkce, žádné RPC.
const fs = require('fs');

const VERDICTS = new Set(['safe', 'caution', 'danger', 'unknown']);
const CATEGORIES = new Set(['scam', 'legit', 'edge']);
const SPLITS = new Set(['tune', 'holdout']);

function validateGoldEntry(e) {
  const errs = [];
  if (!e || typeof e !== 'object') return ['entry is not an object'];
  if (typeof e.id !== 'string' || e.id.length === 0) errs.push('id missing');
  if (typeof e.mint !== 'string' || e.mint.length < 32) errs.push('mint invalid');
  if (!CATEGORIES.has(e.category)) errs.push(`category must be scam|legit|edge, got ${e.category}`);
  if (!SPLITS.has(e.split)) errs.push(`split must be tune|holdout, got ${e.split}`);
  const l = e.label || {};
  if (!VERDICTS.has(l.verdict)) errs.push(`label.verdict must be lowercase safe|caution|danger|unknown, got ${l.verdict}`);
  const [lo, hi] = Array.isArray(l.score_range) ? l.score_range : [];
  if (!Array.isArray(l.score_range) || l.score_range.length !== 2
      || typeof lo !== 'number' || typeof hi !== 'number' || lo > hi)
    errs.push('label.score_range must be [lo,hi] numbers with lo<=hi');
  if (!Array.isArray(e.sources) || e.sources.length === 0) errs.push('sources[] must be non-empty');
  const s = e.snapshot || {};
  if (s.enrichment == null) errs.push('snapshot.enrichment missing');
  if (s.goplus == null) errs.push('snapshot.goplus missing');
  if (!Array.isArray(e.must_flag)) errs.push('must_flag must be array');
  if (!Array.isArray(e.must_not_flag)) errs.push('must_not_flag must be array');
  return errs;
}

function loadAnchor(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const allErrs = [];
  (data.tokens || []).forEach((t, i) => {
    const errs = validateGoldEntry(t);
    if (errs.length) allErrs.push(`token[${i}] (${t.id || t.mint}): ${errs.join('; ')}`);
  });
  if (allErrs.length) throw new Error(`Gold anchor validation failed:\n${allErrs.join('\n')}`);
  return data;
}

module.exports = { validateGoldEntry, loadAnchor, VERDICTS, CATEGORIES, SPLITS };
