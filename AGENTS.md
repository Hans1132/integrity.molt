# Agents: integrity.molt Multi-Agent Architecture

## Core Agent Types

### 1. AuditAgent (Primary)
Analyzes smart contracts using GPT-4 and generates security findings.

**Responsibilities:**
- Parse contract code (bytecode or source)
- Call GPT-4 with security analysis prompts
- Score findings by severity (critical, medium, low)
- Format reports for user consumption
- Track API costs

**Triggering Events:**
- `/audit <address>` command from Telegram
- Scheduled monitoring (subscription users)
- Marketplace audit requests

**Output:**
```
Finding: Reentrancy vulnerability detected
Severity: CRITICAL
Location: function withdraw()
Recommendation: Use checks-effects-interactions pattern
```

### 2. TelegramAgent
Manages all user interactions via Telegram bot.

**Responsibilities:**
- Parse and validate user commands
- Queue audit requests
- Deliver results and reports
- Handle payment confirmation
- Manage user preferences

**Commands:**
- `/audit <address>` - Request security audit
- `/subscribe` - Enable monitoring
- `/history` - View audit history
- `/status` - Check agent status
- `/help` - Show help

**Output:**
Formatted Telegram messages with emojis, links to on-chain verification

### 3. PaymentAgent (Phase 2)
Handles SOL transaction processing and billing.

**Responsibilities:**
- Validate payment amounts
- Create and sign Solana transactions
- Track payment receipts
- Enforce access control (paid users only)
- Refund on failed audits

**Integration Points:**
- Phantom wallet / Molt.id signer
- Solana RPC
- User account mapping

### 4. StorageAgent (Phase 2)
Persists audit data and user profiles.

**Responsibilities:**
- Save audit reports to R2
- Anchor on-chain via Metaplex Core
- Retrieve user history
- Cache popular contract analyses
- Manage retention policies

**Storage Targets:**
- R2: User profiles, audit reports, logs
- On-chain: Proof-of-completion NFTs

### 5. MonitoringAgent (Phase 3)
Tracks agent health and triggers alerts.

**Responsibilities:**
- Log all API calls (cost tracking)
- Monitor uptime and error rates
- Alert on quota approaching
- Publish metrics to Moltbook
- Escalate critical failures

**Metrics:**
- Audits completed / hour
- Average response time
- API error rate
- Cost per audit
- User satisfaction score

## Agent Communication
All agents use event-driven message queue (in-memory for Phase 1):

```
TelegramAgent
    ↓ (AuditRequest)
AuditAgent
    ↓ (FindingsReady)
StorageAgent + TelegramAgent
    ↓ (AuditComplete)
MonitoringAgent
```

## Scaling Strategy
- **Phase 1:** Single-process agent (all in `__main__.py`)
- **Phase 2:** Multi-threaded (one thread per user session)
- **Phase 3:** Distributed (separate microservices on OpenClaw)

## Error Handling
Each agent has retry logic:
- Network errors: Retry 3x with exponential backoff
- API errors: Log + inform user "Try again later"
- User errors: Return helpful error message
- Critical errors: Escalate to MonitoringAgent
