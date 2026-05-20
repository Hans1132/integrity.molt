# IRIS v2.0 Weights — Audit Trail

**File:** `data/rules-v2.json`
**Version:** v2.0.0
**Calibrated:** 2026-05-19 against SolRPDS 2025 dataset + iris-analysis-results.json
**Q-ratify:** Q6 brainstorm — plain JSON + this sidecar (no json5 dep).

## Weight provenance per dimension (sum = 100)

| Dimension | Weight | Evidence source |
|-----------|-------:|-----------------|
| `liquidity` | 18 | SolRPDS arXiv 2504.07132: `inactive_pool` 57.8% + `liquidity_drain` 21.4% = 79% of rug patterns. Top single factor. |
| `authority` | 15 | RugCheck top finding category; mint/freeze are direct rug enablers per RugCheck telemetry (cross-service consensus). |
| `concentration` | 13 | Mazorra 2022 (SHAP feature importance #1: `n_unique_addresses`). Top holder + insider patterns predictive. |
| `lineage` | 13 | SolRugDetector arXiv 2603.24625 — "fraudulent syndicates" finding. Serial deployer signal. |
| `reputation` | 12 | Cross-service consensus (RugCheck + Solana Tracker + GoPlus) reduces single-source false-positive rate. |
| `trading` | 11 | Mazorra SHAP: `num_transactions`, `difference_token_pool` mid-tier importance. Post-deploy behavior. |
| `honeypot` | 10 | GoPlus-driven (Scope A introduces this source). Gating signal — buy/sell capable. |
| `age` | 8 | Proxy correlated with concentration & liquidity. Standalone signal weight low — most info comes from interaction with other dims. |

## Threshold provenance

| Key | Value | Rationale |
|-----|------:|-----------|
| `soft_floor_min_confidence` | 0.5 | Below 0.5 confidence in `known_scams.confidence_score`, soft floor does NOT activate (avoid penalizing tokens flagged with low confidence by upstream ingest). Cutoff matches SolRPDS confidence distribution percentile (manual inspection 2026-05-19). |
| `soft_floor_offset` | 50 | When floor active, lower bound is 50. Matches "danger" tier floor (≥ grade_danger_min=70 with `confidence × scale`=40 max addition). |
| `soft_floor_scale` | 40 | At confidence=1.0, floor pins to 50+40=90. Caps below 100 to preserve headroom for top-tier signals. |
| `soft_whitelist_reduction` | 0.7 | Tier-1 whitelisted tokens retain 30% of computed score. Aggressive enough to keep majors (USDC/SOL) in "safe", soft enough to allow tier-1 with strong negative signals (e.g., new Token-2022 extension on a whitelisted mint) to drift into caution. |
| `grade_safe_max` | 39 | Preserved from existing `src/enrichment/metaplex-agent.js:320` `scoreToRisk` (40/70 boundaries). Per amendment §1.3: no evidence base for shifting; deferred to post-deploy calibration cycle (§1.4). |
| `grade_caution_max` | 69 | Same preservation. |
| `grade_danger_min` | 70 | Same preservation. |

## Circuit breaker provenance

| Key | Value | Rationale |
|-----|------:|-----------|
| `enrichment_timeout_ms` | 600 | Per-source hard timeout. Hot path budget <1s P95 leaves ~400ms slack for scoring + sign + DB write. Matches GoPlus production p95 observation (free tier rate). |
| `consecutive_failures_open` | 3 | Three is a balance — single failure could be transient, two reasonable retry territory, three justifies opening to avoid cascading user-facing latency. |
| `cooldown_ms` | 60000 | 1 minute. Long enough to let upstream recover. Short enough not to leave dimension dropped for whole production-traffic spike window. |
| `confidence_drop_per_failed_dim` | 1 | Each failed dimension drops `confidence_level` one tier (high → medium → low → insufficient/null). |

## Change history

- **2026-05-19 v2.0.0** — initial weights for Scope A. Preserved metaplex thresholds 40/70 per Hansova výhrada in amendment §1.3.
- **2026-05-19 v2.0.1** — Amendment v3 added external oracle danger floor mechanism (3 new threshold keys: `external_oracle_floor_min_score_norm`, `external_oracle_floor_offset`, `external_oracle_floor_scale`). Bridges ingest-lag gap discovered during T0 pre-flight when `5pdyeWSC` token (used as Bucket D regression anchor) found absent from `known_scams`. Bumps `rules-v2.json` schema to v2.0.1 (no breaking — additive keys, JSON.parse-compatible).

## Update protocol

When changing any weight or threshold:
1. Edit the JSON file (single source of truth for the runtime).
2. Add a row to "Change history" in this file with date, old value, new value, rationale (paper or empirical observation).
3. Bump `version` in JSON.
4. systemd restart applies.
5. Test gate (step 17) re-runs against labeled dataset.

## External oracle floor (Amendment v3, 2026-05-19)

Mechanism: when external oracle (RugCheck currently; extensible to GoPlus/Birdeye in future Scope B) classifies token as `danger` with high score_norm AND our `known_scams` DB has no matching entry (or low-confidence entry), apply continuous floor to total score. Bridges ingest-lag and source-coverage gaps where fresh external-oracle danger flags don't propagate to internal DB fast enough.

| Key | Value | Rationale |
|-----|------:|-----------|
| `external_oracle_floor_min_score_norm` | 50 | RC `risk_level === 'danger'` typically correlates with `score_norm ≥ 50`. Below this, RC tags `warn` or lower — different semantics. |
| `external_oracle_floor_offset` | 51 | Preserves v1 minimum behavior (`src/features/iris-score.js:417-418` step floor 51 for `isRcDanger && !knownScam`). Continuous-compatible value at score_norm=50 boundary. |
| `external_oracle_floor_scale` | 0.6 | Gradient. score_norm=75 → floor 66 (mid-caution). score_norm=100 → floor 81 (top of caution band). Calibrated to keep floor in caution range for moderate RC danger, escalate to danger for strong RC signal. Tunable post-deploy via Scope B calibration cycle. |

### Generalization

This is NOT a 5pdyeWSC-specific patch. Pattern: any token flagged `danger` by RugCheck with high score_norm that hasn't been ingested into `known_scams` yet (or has low ingest confidence). Three real causes: (a) ingest lag between RC flag and SolRPDS poller cadence, (b) source coverage where RC sees tokens our DB sources don't, (c) confidence threshold mismatch in SolRPDS ingest pipeline producing entries below 0.5.

### Activation condition

```
rugcheck.risk_level === 'danger'
AND rugcheck.score_norm >= external_oracle_floor_min_score_norm
AND (no known_scams entry OR known_scams.confidence < soft_floor_min_confidence)
```

When activated, signal name `external_oracle_danger_floor_applied` is appended to top-level `risk_factors` array (not to any dimension's `signals[]` — floor is mechanism-level).

### Bucket D re-verify (5pdyeWSC, score_norm=71, no known_scams entry)

- v1 score: 51 (from step floor `isRcDanger && !knownScam → max(.,51)`)
- v2 score (no external floor): ~9 (FAIL Bucket D)
- v2 score (with external floor): `51 + (71−50) × 0.6 = 63.6 → 64` (PASS Bucket D, 13-point margin)
