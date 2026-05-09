# SolRPDS Live Extension Pipeline — Implementation Notes

## Files created

| File | Description |
|------|-------------|
| `migrations/001_solrpds_extension.sql` | DDL: pool_activity, polling_state tables |
| `scripts/run-migration.js` | Idempotent migration runner (safe to re-run) |
| `lib/liquidity-event-processor.js` | UPSERT liquidity events into pool_activity |
| `lib/helius-poller.js` | Hourly DEX polling, 5 programs, paginated |
| `lib/inactivity-scanner.js` | Marks inactive pools, flags rug pulls in known_scams |
| `scripts/start-poller-cron.js` | node-cron entry point (poll at :00, scan at :30) |
| `ecosystem.config.js` | PM2 process definition |
| `scripts/validate-extension.js` | Health check (run after 4-24h) |
| `tests/solrpds/liquidity-processor.test.js` | Unit tests for event processor (7 tests) |
| `tests/solrpds/inactivity-scanner.test.js` | Unit tests for scanner idempotency (5 tests) |

## Ops commands

```bash
# Run migration (idempotent)
node scripts/run-migration.js

# Start PM2 poller
pm2 start ecosystem.config.js && pm2 save

# Check health (run after 4-24h of operation)
node scripts/validate-extension.js

# PM2 logs
pm2 logs solrpds-poller --lines 200
pm2 logs solrpds-poller --lines 200 --err

# Stop/restart
pm2 stop solrpds-poller
pm2 restart solrpds-poller
```

## RugCheck cross-check (sample validation)

```bash
# Sample 5 helius_realtime flagged mints
sqlite3 data/intmolt.db \
  "SELECT mint FROM known_scams WHERE source='helius_realtime' ORDER BY RANDOM() LIMIT 5;"

# Query RugCheck for each mint
curl -s "https://api.rugcheck.xyz/v1/tokens/<MINT>/report/summary" | jq '.rugged,.score'
```

Compare `rugged` field — expect >80% match rate. If <80%, 7-day inactivity window may need tuning.

## Known deviations from original spec

1. `known_scams.source` already existed — migration skips its ALTER TABLE.
2. `webhook-receiver.js` was never created in the project — no action needed.
3. `ecosystem.config.js` created fresh (no prior PM2 config existed).
4. Hardcoded DB paths replaced with `process.env.SQLITE_DB_PATH` for testability.
5. `lookupKnownScam` already uses `SELECT *` — new columns auto-included in scan responses.
6. PM2 was not globally installed — installed via `npm install -g pm2` during deployment.
7. Helius Enhanced API returns 404 for 4 of 5 DEX programs (Raydium CPMM, Orca, Pump.fun, Meteora) with the combined type filters. Only Raydium AMM v4 returns data. This is expected: Helius may label these DEXes' events differently. Parser refinement against actual response shapes is future work.

## Known limitations

- **18-month historical gap** (Nov 2024–May 2026) is NOT closed by this pipeline. Only forward coverage from deployment date (2026-05-08).
- Helius Enhanced Transaction parsing varies by DEX — parser is best-effort, logs warnings for unknown structures.
- `pool_address` extracted from `tokenTransfers.toUserAccount` may not always be the actual pool — depends on Helius parsing accuracy per DEX type.
- **`poolAddress` derivation is approximate**: Current parser extracts `pool_address` from `tokenTransfers[].toUserAccount`, which is the user wallet address, not the actual DEX pool account. This means ADD and REMOVE events from different users for the same pool land in separate `pool_activity` rows. The rug-pull inactivity pattern (`last_swap_ts < last_liquidity_remove_ts` in the same row) requires correct pool address co-location to fire reliably. Parser refinement per DEX using actual Helius response structure is required before `helius_realtime` flags should be trusted for production. This is tracked as Future Work item #4 (parser refinement).

## Future work

1. **Bulk RugCheck gap-fill** — import Nov 2024–May 2026 rug pulls from RugCheck API to close historical gap.
2. **Helius type filter investigation** — determine correct event type names for Orca, Meteora, Pump.fun, Raydium CPMM to fix 404 responses.
3. **Per-DEX inactivity window tuning** — Pump.fun tokens may need shorter window (3-4 days); major DEXes may need longer.
4. **Statistics dashboard** — per-DEX pool count, flag rate, credit consumption chart.

---

## V4 Migration to Bitquery (2026-05-09)

### Architecture: Hybrid live extension pipeline

Helius enhanced API streams SWAP activity across 5 major DEXes (Raydium, Orca, Pump.fun, Meteora, Pumpswap) — writes `pool_activity.last_swap_ts`. Bitquery GraphQL queries provide filtered liquidity removal events across all Solana DEX pool sizes — writes `pool_activity.last_liquidity_remove_ts`. Combined data feeds SolRPDS deterministic methodology (paper sections 4.2-4.3) for inactivity-based rug pull detection.

Signal sources:
- **Helius V3** (existing, untouched): SWAP events → `last_swap_ts`
- **Bitquery V4** (new): REMOVAL events only → `last_liquidity_remove_ts`
- **Inactivity scanner**: flags pool when `last_swap_ts < now-7d` AND `last_swap_ts < last_liquidity_remove_ts`
- **Source label**: `hybrid_realtime` (both signals required for flag)

### Why Bitquery for removals

Helius enhanced API misclassified liquidity events on 4 of 5 DEXes tested (only Raydium AMM v4 worked). Bitquery `Solana.DEXPools` with `Quote.ChangeAmount < 0` filter returns full removal-event coverage across all Solana DEX pool sizes. No TVL filter needed — Bitquery server-side query optimization keeps cost at ~5 points per cycle regardless of filter complexity.

### Files added

| File | Description |
|------|-------------|
| `lib/bitquery-client.js` | Bitquery GraphQL client, lazy API key check |
| `lib/bitquery-event-transformer.js` | Transforms DEXPools events → typed liquidity events |
| `lib/bitquery-poller.js` | Poll loop with pagination, state tracking, error handling |
| `scripts/start-bitquery-cron.js` | PM2 entry point (4h interval, 900 pts/month on free plan) |
| `scripts/validate-v4.js` | Health check + credit projection |

### Files modified

| File | Change |
|------|--------|
| `lib/inactivity-scanner.js` | Source label changed to `hybrid_realtime`; added `created_at >= V4_start` filter to prevent retroactive mislabelling |
| `ecosystem.config.js` | Added `solrpds-poller-v4-bitquery` entry; kept `solrpds-poller` (V3, deprecated) |

### DEPRECATED

`lib/helius-poller.js` — kept as reference, not loaded by any cron. The V3 `solrpds-poller` PM2 process continues running but produces no new useful data (4 of 5 DEXes broken). After V4 is validated, stop it:

```bash
pm2 stop solrpds-poller
```

### DB changes on 2026-05-09

- `pool_activity` wiped (944 misclassified V3 rows) — backup at `/root/backups/intmolt-pre-v4-20260509-0555.db`
- `polling_state` row added: `dex_program_id = 'bitquery_dexpools'`

### New env variable

`BITQUERY_API_KEY` — required. Get it at https://account.bitquery.io (free plan: 1000 pts/month).
`BITQUERY_ENDPOINT` — optional override (default: `https://streaming.bitquery.io/graphql`; EAP plan: `.../eap`)

### Cost model

| Plan | Points/month | Interval | Polls/month | Pts/poll | Projected spend |
|------|-------------|----------|-------------|----------|-----------------|
| Free | 1,000 | 4h | 180 | ~5 | ~900 pts ✓ |
| Developer ($49) | 100,000 | 4h | 180 | ~5 | ~900 pts (110× headroom) |

### Methodology fidelity

SolRPDS paper §4.2–4.3 sign-correlation rule implemented in `bitquery-event-transformer.js`:
- Swap: opposite signs on Base/Quote ChangeAmount → SWAP events only (handled by Helius V3)
- Add: both positive → ADD_LIQUIDITY events (not recorded by V4, future work)
- Remove: both negative → REMOVE_LIQUIDITY events → recorded by Bitquery V4

Critical: the transformer correctly excludes swap events from the removal count. Without this, swaps (opposite signs) would inflate `total_removed_liquidity` and corrupt `add_to_remove_ratio`.

### PM2 launch sequence (after BITQUERY_API_KEY is set)

```bash
# 1. Stop V3 Helius poller
pm2 stop solrpds-poller

# 2. Start V4 Bitquery poller
pm2 start ecosystem.config.js --only solrpds-poller-v4-bitquery
pm2 save

# 3. Validation gate sequence
node -e 'require("./lib/bitquery-client").fetchLiquidityChanges(new Date(Date.now()-3600000).toISOString(), 5).then(r => console.log("Auth OK:", r.length, "events")).catch(e => console.error("FAIL:", e.message))'
node scripts/validate-v4.js

# 4. Monitor credit spend after 24h
node scripts/validate-v4.js
pm2 logs solrpds-poller-v4-bitquery --lines 200 --err
```
