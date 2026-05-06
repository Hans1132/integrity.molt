# Development Guide — integrity.molt

## Setup

### 1. Clone Repository

```bash
git clone https://github.com/Hans1132/integrity.molt /root/x402-server
cd /root/x402-server
```

### 2. Install Dependencies

```bash
npm install
```

**Key dependencies:**
- `express` 5.x — HTTP framework
- `better-sqlite3` — SQLite bindings
- `tweetnacl` — Ed25519 signing (client-side)
- `@cheapay/x402` — x402 payment protocol
- `@solana/web3.js` — Solana blockchain
- `@solana/spl-token` — SPL token utilities

### 3. Create `.env` File

```bash
cp .env.example .env
```

**Required environment variables:**

```env
PORT=3402
NODE_ENV=development

# Solana RPC endpoints
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
ALCHEMY_RPC_URL=https://solana-mainnet.g.alchemy.com/v2/YOUR_API_KEY

# Payment wallet
USDC_ATA=<YOUR_USDC_ATA_ADDRESS>
SOLANA_WALLET_ADDRESS=<YOUR_WALLET_ADDRESS>

# Optional: Transaction fee service APIs
HELIUS_API_KEY=<optional>
OPENROUTER_API_KEY=<optional>

# Database (default: data/intmolt.db)
SQLITE_DB_PATH=/root/x402-server/data/intmolt.db

# Stripe (legacy, minimal use)
STRIPE_SECRET_KEY=<optional>
```

### 4. Create Ed25519 Keys

Keys are stored in `/root/.secrets/` (NOT committed to git):

```bash
mkdir -p /root/.secrets

# Option A: Generate new keys
node -e "
const nacl = require('tweetnacl');
const fs = require('fs');
const keypair = nacl.sign.keyPair();
fs.writeFileSync('/root/.secrets/signing_key.bin', keypair.secretKey);
fs.writeFileSync('/root/.secrets/verify_key.bin', keypair.publicKey);
console.log('Keys created in /root/.secrets/');
"

# Option B: Use existing keys (from password manager or secure backup)
# Paste the binary files into /root/.secrets/
```

**Verify keys were created:**

```bash
ls -la /root/.secrets/
# -rw------- signing_key.bin (32 bytes)
# -rw------- verify_key.bin  (32 bytes)
```

### 5. Create Database

The database is auto-initialized on first run:

```bash
mkdir -p /root/x402-server/data
node server.js
# First startup initializes schema in data/intmolt.db
```

## Running the Server

### Development (with auto-reload)

Using `nodemon` (install globally):

```bash
npm install -g nodemon
nodemon server.js
```

The server will restart on file changes.

### Production

Using systemd service:

```bash
systemctl start integrity-x402.service
systemctl status integrity-x402.service
systemctl logs -f integrity-x402.service
```

**Service file:** `/etc/systemd/system/integrity-x402.service`

### Port Binding

By default, the server runs on **port 3402**. In production:
- NGINX reverse proxy on port 80 (HTTP) forwards to 3402
- Cloudflare handles TLS termination on port 443
- Real IP detected from `CF-Connecting-IP` header

For local testing on a different machine, use a local tunnel:

```bash
# ngrok or cloudflare tunnel
cf tunnel run --url http://localhost:3402
```

## API Testing

### Quick Scan (Free, No Auth)

```bash
curl -X POST https://intmolt.org/a2a \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "test-1",
    "method": "tasks/send",
    "params": {
      "message": {"role": "user", "parts": [{"type": "text", "text": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"}]},
      "metadata": {"skill": "quick_scan", "address": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"}
    }
  }'
```

**Expected response (200 OK):**
```json
{
  "jsonrpc": "2.0",
  "id": "test-1",
  "result": {
    "iris_score": 92,
    "risk_level": "low",
    "signature": "...",
    "verify_key": "...",
    "signed_at": "...",
    "key_id": "integrity-molt-primary-2026"
  }
}
```

### Verify Receipt (Free, Server-side)

```bash
curl -X POST https://intmolt.org/verify/v1/signed-receipt \
  -H "Content-Type: application/json" \
  -d '{"envelope": <paste_above_response>}'
```

**Expected response (200 OK):**
```json
{
  "valid": true,
  "key_pinned": true,
  "mathematically_valid": true,
  "reason": "signature_valid"
}
```

### Paid Scan (With x402 Payment)

1. **Probe** (get payment instructions):
```bash
curl -X POST https://intmolt.org/a2a \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "1",
    "method": "tasks/send",
    "params": {
      "message": {"role": "user", "parts": [...]},
      "metadata": {"skill": "token_audit", "address": "EPjFWdd5..."}
    }
  }'
```

2. **Response** (402 Payment Required):
```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "error": {
    "code": -32602,
    "message": "Payment required",
    "data": {
      "x402Version": 1,
      "accepts": [{"mint": "EPjFWdd5...", "decimals": 6, "amount": 750000}],
      "price_usd": 0.75
    }
  }
}
```

3. **Sign transaction** on Solana, include x402-payment header:
```bash
curl -X POST https://intmolt.org/a2a \
  -H "Content-Type: application/json" \
  -H "x402-payment: <base64-envelope>" \
  -d '{...same request as step 1...}'
```

4. **Response** (200 OK with result)

## Testing

### Unit Tests

```bash
npm run test
```

Runs all tests (~187 passing tests):
- E2E smoke tests
- Security checks (no secrets in code)
- A2A handler tests (91 tests)
- Anti-replay tests
- Free quota tests
- Task store tests
- IRIS score tests
- Report validator tests
- Pricing consistency tests

**Individual test suites:**

```bash
npm run test:anti-replay      # Payment anti-replay protection
npm run test:a2a              # A2A JSON-RPC 2.0 handler
npm run test:quota            # Free scan rate limiting
npm run test:task-store       # A2A task persistence
npm run test:iris             # IRIS scoring engine
npm run test:report-validator # Report validation rules
npm run test:pricing          # Pricing consistency checks
```

### Test Coverage

Tests use **in-memory SQLite** to avoid touching production database:

```javascript
// Set before requiring db module
process.env.SQLITE_DB_PATH = ':memory:';
const db = require('./db');
```

**Gaps (known limitations):**
- Helius live API not tested (requires API key, uses mock in tests)
- x402 requirePayment middleware not tested via router (mounted bare, bypassed)
- asyncSign not invoked (stubbed with node crypto)
- Real Solana RPC calls not tested (use mocked responses)
- Real enrichment APIs not tested (stubbed)

### Test Gate Script

Before committing, run the test gate:

```bash
bash scripts/test-gate.sh
```

This runs:
1. Full test suite (`npm run test`)
2. No-secrets check (grep for API keys, privates)
3. OpenAPI coverage check (docs/admin-only)

**Exit code:**
- 0 = all gates passed, safe to commit
- 1 = gates failed, DO NOT COMMIT

Example:

```bash
$ bash scripts/test-gate.sh
Running test suite...
[✓] All 187 tests passed
[✓] No secrets found in code
[✓] OpenAPI spec complete
Gate PASSED. Safe to commit.
```

### Manual Testing on Mainnet

**Smoke test against live deployment:**

```bash
export API_URL=https://intmolt.org
bash scripts/smoke-a2a.sh
```

This:
1. Calls all free endpoints
2. Verifies response formats
3. Checks signatures
4. Measures latency

Expected output:
```
[OK] GET /scan/v1/... (92ms)
[OK] GET /feed/v1/... (45ms)
[OK] POST /verify/v1/... (12ms)
All smoke tests passed.
```

## Code Organization

### File Structure

```
/root/x402-server/
├── server.js                    ← Main Express app (~5000 lines)
├── db.js                        ← SQLite layer (~1000 lines)
├── package.json
├── .env.example
├── .env                         ← GITIGNORED
│
├── config/
│   └── pricing.js              ← Single source of truth for prices
│
├── src/
│   ├── a2a/
│   │   ├── handler.js          ← JSON-RPC 2.0 router
│   │   ├── task-store.js       ← Task persistence
│   │   ├── autopilot.js        ← AutoPilot co-signing
│   │   └── ...
│   ├── routes/
│   │   └── a2a-oracle.js       ← Oracle REST endpoints
│   ├── middleware/
│   │   ├── payment.js          ← PDA verification
│   │   └── free-quota.js       ← Rate limiting
│   ├── crypto/
│   │   └── sign.js             ← asyncSign, canonicalJSON
│   ├── payment/
│   │   └── verify-pda.js       ← Metaplex PDA derivation
│   ├── features/
│   │   └── iris-score.js       ← IRIS scoring logic
│   ├── monitor/
│   │   ├── alerts.js           ← Detection engine
│   │   └── webhook-receiver.js ← Helius webhook handling
│   ├── lib/
│   │   └── ottersec.js         ← OtterSec API integration
│   └── ...
│
├── tests/
│   ├── e2e/
│   ├── payment/
│   ├── middleware/
│   ├── a2a/
│   ├── features/
│   ├── validation/
│   └── ...
│
├── scripts/
│   ├── test-gate.sh
│   ├── smoke-a2a.sh
│   └── ...
│
├── data/
│   └── intmolt.db              ← SQLite database (GITIGNORED)
│
├── docs/
│   ├── README.md               ← Public documentation
│   ├── architecture.md         ← This doc set
│   ├── skills.md
│   ├── payments.md
│   ├── database.md
│   ├── signing.md
│   └── development.md
│
└── .secrets/                   ← GITIGNORED (never committed)
    ├── signing_key.bin
    └── verify_key.bin
```

## Key Development Patterns

### 1. No Blocking Operations in Event Loop

❌ **Bad:**
```javascript
const result = execSync('python3 sign.py', {input: payload});
```

✅ **Good:**
```javascript
const envelope = await asyncSign(payload);
```

See `src/crypto/sign.js` for the pattern (semaphore-bounded subprocess).

### 2. Always Use Canonical JSON for Signatures

❌ **Bad:**
```javascript
const sig = sign(JSON.stringify(obj));  // Key order undefined
```

✅ **Good:**
```javascript
const sig = sign(canonicalJSON(obj));   // Deterministic
```

See `src/crypto/sign.js` for implementation.

### 3. Anti-Replay: Mark Before Responding

❌ **Bad:**
```javascript
// Respond first, then mark as used (race condition)
res.json(result);
markSignatureUsed(txSig);  // Too late — replay can happen here
```

✅ **Good:**
```javascript
// Mark BEFORE response (atomic INSERT OR IGNORE)
if (!markSignatureUsed(txSig)) {
  return res.status(402).json({error: 'Already used'});
}
res.json(result);
```

### 4. Cache TTL Checks

❌ **Bad:**
```javascript
const row = db.prepare('SELECT result_json FROM scan_history WHERE address=?').get(address);
return JSON.parse(row.result_json);  // No TTL check!
```

✅ **Good:**
```javascript
const cached = getCachedScanFromDb(address, scanType, 30 * 60 * 1000);  // 30 min TTL
if (cached) return cached;
// Cache miss — compute
```

### 5. Error Handling in Async Code

❌ **Bad:**
```javascript
const envelope = await asyncSign(payload);  // No error handling
```

✅ **Good:**
```javascript
let envelope = null;
try {
  envelope = await asyncSign(payload);
} catch (e) {
  console.warn('[scan] signing failed (non-fatal):', e.message);
  // Continue without signature
}
```

### 6. Real IP Detection

❌ **Bad:**
```javascript
const ip = req.headers['x-forwarded-for'];  // Can be spoofed
```

✅ **Good:**
```javascript
const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip;
// Cloudflare header takes priority
```

### 7. Single Source of Truth for Pricing

❌ **Bad:**
```javascript
const price = 750_000;  // Hard-coded price
```

✅ **Good:**
```javascript
const {PRICING} = require('./config/pricing');
const price = PRICING['token-audit'];  // Read from config
```

## Common Tasks

### Add a New Skill

1. **Define in A2A handler** (`src/a2a/handler.js`):
```javascript
const SKILLS = {
  'my_new_skill': {
    name: 'My New Skill',
    description: '...',
    inputModes: ['text/plain'],
    outputModes: ['application/json'],
    priceUSDC: 0.50,
    tags: ['solana', 'security'],
  },
  // ... existing skills
};
```

2. **Implement executor** in `executeSkill()`:
```javascript
case 'my_new_skill':
  return internalPost('/scan/my-endpoint', {address}, paymentHeader, 60_000);
```

3. **Add pricing** (`config/pricing.js`):
```javascript
const PRICING = {
  'my-skill': 500_000,  // 0.50 USDC
  // ... existing
};
```

4. **Implement REST route** in `server.js`:
```javascript
app.post('/scan/my-endpoint', requirePayment(...), async (req, res) => {
  // Implementation
});
```

5. **Add tests** (`tests/a2a-handler.test.js`):
```javascript
test('executeSkill: my_new_skill', async () => {
  const result = await executeSkill('my_new_skill', address);
  assert(result.iris_score !== undefined);
});
```

6. **Update discovery** (agent-card.json is auto-generated from SKILLS)

7. **Test gate:**
```bash
npm run test:pricing  # Verify pricing consistency
npm run test          # Full suite
bash scripts/test-gate.sh
```

### Debug Signing Issues

```bash
# 1. Check keys exist
ls -la /root/.secrets/signing_key.bin /root/.secrets/verify_key.bin

# 2. Test sign script manually
echo '{"test":"data"}' | python3 /root/scanner/sign-report.py

# 3. Verify canonicalJSON
node -e "
const {canonicalJSON} = require('./src/crypto/sign');
console.log(canonicalJSON({b: 2, a: 1}));
// Expected: {\"a\":1,\"b\":2}
"

# 3. Trace asyncSign call
NODE_DEBUG=* node server.js 2>&1 | grep -i sign
```

### Debug Payment Issues

```bash
# 1. Check payment log
sqlite3 /root/x402-server/data/intmolt.db \
  "SELECT tx_sig, verified, reason FROM payments ORDER BY created_at DESC LIMIT 10;"

# 2. Check anti-replay table
sqlite3 /root/x402-server/data/intmolt.db \
  "SELECT sig FROM used_signatures ORDER BY created_at DESC LIMIT 10;"

# 3. Inspect raw transaction on Solana Explorer
# https://explorer.solana.com/tx/<TX_SIGNATURE>

# 4. Check if USDC ATA is correct
solana account $USDC_ATA -um
```

### Debug Rate Limiting

```bash
# 1. Check quota table
sqlite3 /root/x402-server/data/intmolt.db \
  "SELECT identifier, scan_date, count FROM free_scan_quota WHERE scan_date >= date('now', '-1 day');"

# 2. Check abuse events
sqlite3 /root/x402-server/data/intmolt.db \
  "SELECT ip, event_type, occurred_at FROM abuse_events WHERE occurred_at > datetime('now', '-1 hour');"

# 3. Check blacklist
sqlite3 /root/x402-server/data/intmolt.db \
  "SELECT ip, reason FROM ip_blacklist WHERE expires_at IS NULL OR expires_at > datetime('now');"
```

## Git Workflow

### Before Committing

```bash
# 1. Check for secrets
grep -rn "PRIVATE\|SECRET\|sk_\|api_key" --include="*.js" src/ | grep -v node_modules

# 2. Run test gate
bash scripts/test-gate.sh

# 3. Format and lint (optional)
npm run lint

# 4. Stage changes
git add src/ config/ docs/

# 5. Commit with conventional message
git commit -m "feat(a2a): add new skill dispatcher"
# or
git commit -m "fix(signing): handle empty payload"
# or
git commit -m "docs(skills): update pricing table"

# 6. Push to origin
git push origin feature/my-feature
```

### Branch Naming

- `feat/{name}` — New feature
- `fix/{name}` — Bug fix
- `refactor/{name}` — Code cleanup
- `docs/{name}` — Documentation

### Commit Message Format

**Conventional commits:** `<type>(scope): <message>`

Examples:
- `feat(a2a): add token_audit skill`
- `fix(payment): check anti-replay before response`
- `docs(signing): add Ed25519 verification guide`
- `test(a2a): add comprehensive error cases`

### Force-Push Safety

**Only use `--force-with-lease`** (never plain `--force`):

```bash
# ✗ Bad
git push --force

# ✓ Good
git push --force-with-lease
```

This rejects the push if someone else pushed since your last pull, preventing accidental history rewrite.

## Troubleshooting

### "Cannot find module" Errors

```bash
# Rebuild native modules
npm install

# Clear cache
npm cache clean --force
npm install
```

### "Port 3402 already in use"

```bash
# Find process using port
lsof -i :3402

# Kill process
kill -9 <PID>

# Or use different port
PORT=3403 node server.js
```

### "Database locked" Errors

SQLite WAL mode allows reads during writes, but if you see "database is locked":

```bash
# 1. Check for long-running queries
systemctl status integrity-x402.service

# 2. Restart server
systemctl restart integrity-x402.service

# 3. Manual checkpoint (if stuck)
sqlite3 /root/x402-server/data/intmolt.db "PRAGMA wal_checkpoint(RESTART);"
```

### "Signature verification failed"

Check that:
1. Canonical JSON is byte-identical (no whitespace differences)
2. Public key from response matches published JWKS
3. Payload reconstruction excludes signature/verify_key fields

See `docs/signing.md` for detailed troubleshooting.

## References

- **CLAUDE.md** — Project rules and constraints
- **CLAUDE.md#4** — Sharp edges (gotchas, anti-patterns)
- **docs/architecture.md** — System design
- **docs/skills.md** — Skill implementations
- **docs/payments.md** — x402 protocol details
- **docs/signing.md** — Ed25519 signature walkthrough
- **src/a2a/handler.js** — A2A implementation (700+ lines, well-commented)
- **tests/** — 187 passing tests, great examples
