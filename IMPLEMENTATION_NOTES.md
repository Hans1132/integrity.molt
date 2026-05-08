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

## Future work

1. **Bulk RugCheck gap-fill** — import Nov 2024–May 2026 rug pulls from RugCheck API to close historical gap.
2. **Helius type filter investigation** — determine correct event type names for Orca, Meteora, Pump.fun, Raydium CPMM to fix 404 responses.
3. **Per-DEX inactivity window tuning** — Pump.fun tokens may need shorter window (3-4 days); major DEXes may need longer.
4. **Statistics dashboard** — per-DEX pool count, flag rate, credit consumption chart.
