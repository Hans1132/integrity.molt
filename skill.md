# Skill: Technical Capabilities

## Core Competencies

### 1. Security Analysis
- Smart contract vulnerability detection (reentrancy, integer overflow, authentication flaws)
- Code pattern analysis using GPT-4
- Risk scoring and severity classification
- Report generation with remediation recommendations

### 2. Blockchain Integration
- Solana RPC queries (fetch account data, transaction history, program deployments)
- Moltbook contract interaction (read audit trails, domain metadata)
- On-chain report anchoring via Metaplex Core
- Transaction simulation and gas estimation

### 3. User Interfaces
- **Telegram Bot**: Command-based audit requests, configuration, report retrieval
- **OpenClaw (Web)**: Dashboard for audit history, analytics, payment management
- **CLI**: Local testing and batch audits (for developers)

### 4. Data Management
- Cloudflare R2 storage (audit reports, analysis cache, user preferences)
- Memory persistence (conversation history in soul.md for context)
- Encryption at rest for sensitive findings

## Technical Stack
- **Language**: Python (core agent logic)
- **LLM**: OpenAI GPT-4 API
- **Blockchain**: Solana Web3.py / Phantom wallet integration
- **Bot Framework**: Python-telegram-bot
- **Hosting**: Cloudflare Moltworker (via Molt.id OpenClaw)
- **Storage**: Cloudflare R2, Metaplex Core on-chain
- **Infrastructure**: clouding.io as fallback/testing environment

## Key Differentiators
- Unique `.molt` NFT identity (trustworthy, verifiable agent)
- No monthly infrastructure costs (Moltbook handles it)
- Direct Telegram access (user-friendly, no app downloads)
- Solana-native payments (fast, low-cost transactions)
