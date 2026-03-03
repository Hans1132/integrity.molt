#!/usr/bin/env python3
"""
OpenClaw Agent Deployment Helper
Automates integration of integrity.molt into OpenClaw/app.molt.id

Usage:
    python deploy_openclaw.py --validate          # Validate config
    python deploy_openclaw.py --export-secrets    # Show what to update
    python deploy_openclaw.py --instructions      # Print setup guide
"""

import json
import sys
from pathlib import Path
from typing import Dict, Any, List


class OpenClawDeployer:
    def __init__(self):
        self.config_path = Path("openclaw_agent_config.json")
        self.redacted_keys = [
            "__OPENCLAW_REDACTED__"
        ]
        
    def load_config(self) -> Dict[str, Any]:
        """Load OpenClaw configuration"""
        if not self.config_path.exists():
            print(f"❌ Config not found: {self.config_path}")
            sys.exit(1)
        
        with open(self.config_path) as f:
            return json.load(f)
    
    def validate_config(self) -> bool:
        """Validate configuration structure"""
        print("\n🔍 Validating OpenClaw configuration...")
        config = self.load_config()
        
        checks = [
            ("agents.list[0]", config.get("agents", {}).get("list", [])),
            ("channels.telegram.enabled", config.get("channels", {}).get("telegram", {}).get("enabled")),
            ("integrations.github.enabled", config.get("integrations", {}).get("github", {}).get("enabled")),
            ("integrations.moltbook.enabled", config.get("integrations", {}).get("moltbook", {}).get("enabled")),
        ]
        
        all_valid = True
        for check_name, check_value in checks:
            if check_value:
                print(f"  ✅ {check_name}")
            else:
                print(f"  ❌ {check_name}")
                all_valid = False
        
        return all_valid
    
    def find_redacted_values(self) -> Dict[str, List[str]]:
        """Find all redacted values that need to be updated"""
        print("\n🔐 Scanning for redacted values...")
        config = self.load_config()
        config_str = json.dumps(config, indent=2)
        
        redacted_locations = {}
        for key in self.redacted_keys:
            if key in config_str:
                lines = config_str.split('\n')
                locations = [i+1 for i, line in enumerate(lines) if key in line]
                redacted_locations[key] = locations
                print(f"  ⚠️  Found {len(locations)} redacted value(s)")
                for loc in locations:
                    print(f"      → Line {loc}")
        
        return redacted_locations
    
    def export_secrets_template(self):
        """Export template for secrets to update"""
        print("\n📋 SECRETS TO UPDATE IN app.molt.id:\n")
        
        secrets_template = """
┌─ TELEGRAM INTEGRATION ─────────────────────────────────┐
│ Field: channels.telegram.botToken                      │
│ Value: Your Telegram Bot Token (from @BotFather)      │
│ Get:   Telegram → @BotFather → /token                 │
├────────────────────────────────────────────────────────┤
│ Field: channels.telegram.webhookSecret                │
│ Value: Moltbook provided webhook secret               │
│ Get:   app.molt.id → Webhooks → Copy token            │
├────────────────────────────────────────────────────────┤
│ Field: channels.discord.webhookUrl (if using)         │
│ Value: Your Discord webhook URL                       │
│ Get:   Discord → Server Settings → Webhooks           │
└────────────────────────────────────────────────────────┘

┌─ OPENAI/LLM MODELS ────────────────────────────────────┐
│ Field: models.providers.openrouter.apiKey             │
│ Value: Your OpenRouter API key                        │
│ Get:   https://openrouter.ai/keys → Create API key    │
│ Cost:  ~$0.001-0.015 per audit (varies by model)     │
└────────────────────────────────────────────────────────┘

┌─ GATEWAY AUTHENTICATION ───────────────────────────────┐
│ Field: gateway.auth.token                             │
│ Value: Random secure token for gateway access         │
│ Gen:   openssl rand -base64 32                        │
└────────────────────────────────────────────────────────┘

┌─ ENVIRONMENT VARIABLES ────────────────────────────────┐
│ Already set in Railway dashboard:                      │
  │ • TELEGRAM_TOKEN=YOUR_TELEGRAM_TOKEN_HERE         │
│ • OPENAI_API_KEY=sk-q6DsDr7uO_o4zHpVgjkst...         │
│ • MONGODB_URI=mongodb+srv://...                       │
│ • AGENT_PRIVATE_KEY=YOUR_SOLANA_PRIVATE_KEY          │
│                                                       │
│ Verify: Railway.app → Settings → Variables           │
└────────────────────────────────────────────────────────┘
        """
        print(secrets_template)
    
    def print_deployment_instructions(self):
        """Print step-by-step deployment guide"""
        instructions = """
╔════════════════════════════════════════════════════════════════════════════╗
║               INTEGRITY.MOLT OPENCLAW DEPLOYMENT GUIDE                      ║
║                          (Step-by-Step)                                     ║
╚════════════════════════════════════════════════════════════════════════════╝

📍 STEP 1: Prepare Configuration
─────────────────────────────────────────────────────────────────────────────

  1.1 Open this file: openclaw_agent_config.json
  
  1.2 Copy the ENTIRE JSON content
  
  1.3 Do NOT modify it yet (we'll fill in secrets next)


📍 STEP 2: Access app.molt.id
─────────────────────────────────────────────────────────────────────────────

  2.1 Go to: https://app.molt.id
  
  2.2 Log in with your Moltbook account (email: lickohonza@gmail.com)
  
  2.3 Navigate to: Dashboard → Agents → integrity.molt
  
  2.4 Click: "Settings" → "Raw Configuration" (or "Advanced Sync")


📍 STEP 3: Paste Configuration
─────────────────────────────────────────────────────────────────────────────

  3.1 In the Raw Configuration Editor, select all (Ctrl+A)
  
  3.2 Delete existing content
  
  3.3 Paste the openclaw_agent_config.json content
  
  3.4 DO NOT SAVE YET - we need to update secrets first


📍 STEP 4: Update Secrets (Critical)
─────────────────────────────────────────────────────────────────────────────

  ⚠️  IMPORTANT: Replace ALL "__OPENCLAW_REDACTED__" values:
  
  4.1 TELEGRAM BOT TOKEN
      Path: channels.telegram.botToken
      Value: Get from @BotFather on Telegram (already provided)
      Current: __OPENCLAW_REDACTED__
      New: YOUR_TELEGRAM_TOKEN_HERE
  
  4.2 OPENROUTER API KEY
      Path: models.providers.openrouter.apiKey
      Value: Get from https://openrouter.ai/keys
      Current: __OPENCLAW_REDACTED__
      New: <your-openrouter-api-key>
  
  4.3 TELEGRAM WEBHOOK SECRET
      Path: channels.telegram.webhookSecret
      Value: Get from Moltbook/Multiclaw dashboard
      Current: __OPENCLAW_REDACTED__
      New: <your-webhook-secret>
  
  4.4 GATEWAY AUTH TOKEN
      Path: gateway.auth.token
      Value: Any secure random string
      Current: __OPENCLAW_REDACTED__
      New: Use: openssl rand -base64 32


📍 STEP 5: Verify Agent Identity
─────────────────────────────────────────────────────────────────────────────

  5.1 Check agent identity fields (should be pre-filled):
      
      agents.list[0].identity:
      {
        "name": "integrity.molt Agent",
        "wallet": "BFmkPKu2tS9RoMufgJUd9GyabzC91hriAbMS6Hmr8TX6",
        "nftIdentity": "2tWPw22bqgLaLdYCwe7599f7guQudwKpCCta4gvhgZZy",
        "domain": "integrity.molt"
      }
  
  5.2 These should be CORRECT - do not modify


📍 STEP 6: Verify Repository Integration  
─────────────────────────────────────────────────────────────────────────────

  6.1 Configuration includes GitHub integration:
      repository.github:
      {
        "owner": "Hans1132",
        "repo": "integrity.molt",
        "branch": "main",
        "autoDeployOnPush": true
      }
  
  6.2 This enables auto-deployment when you push to main


📍 STEP 7: Save & Deploy
─────────────────────────────────────────────────────────────────────────────

  7.1 In Raw Configuration Editor:
      Click: "Save" (or "Update Configuration")
  
  7.2 Wait for validation to complete (should show ✓)
  
  7.3 Click: "Deploy" or "Apply"
  
  7.4 System will:
      ✓ Validate configuration syntax
      ✓ Test connections (Telegram, MongoDB, GitHub)
      ✓ Start agent on OpenClaw runtime
      ✓ Register with Moltbook


📍 STEP 8: Verify Deployment
─────────────────────────────────────────────────────────────────────────────

  8.1 Wait 30-60 seconds for agent initialization
  
  8.2 Check: app.molt.id → Agents → integrity.molt → Status
      Should show: 🟢 ACTIVE
  
  8.3 Test Telegram integration:
      • Send /help to your bot
      • Should receive: "Welcome to integrity.molt audit agent"
  
  8.4 Check logs:
      app.molt.id → Dashboard → Logs
      Look for: "Agent startup successful" + "JWT token generated"
  
  8.5 Monitor metrics:
      app.molt.id → Metrics
      Should show: Agent health > 90%


📍 STEP 9: Test Audit Flow
─────────────────────────────────────────────────────────────────────────────

  9.1 Send Telegram command (to your bot):
      /audit 0x06e1c7bFcC20C4f4dab1b93C2d2Ee6c5E0a4c2C5
  
  9.2 Bot should respond with:
      ✅ Officially Verified by integrity.molt
      [Audit results...]
      Transaction ID: [hash]
  
  9.3 Test force refresh:
      /audit 0x06e1c7bFcC20C4f4dab1b93C2d2Ee6c5E0a4c2C5 --force
      (Should bypass cache and perform new audit)


📍 STEP 10: Enable Marketplace Publishing (Optional)
─────────────────────────────────────────────────────────────────────────────

  10.1 If you want audits published to Moltbook marketplace:
       
       integrations.moltbook.marketplace.publishAudits: true
       
  10.2 Save & redeploy
  
  10.3 New audits will now appear in:
       app.molt.id → Marketplace → Security Audits


═════════════════════════════════════════════════════════════════════════════

✅ DEPLOYMENT CHECKLIST

Before deployment:
  ☐ Generated all secrets (__OPENCLAW_REDACTED__ replaced)
  ☐ Verified agent identity fields are correct
  ☐ Checked GitHub repository integration
  ☐ Confirmed Railway variables are set

During deployment:
  ☐ Configuration passes syntax validation
  ☐ Connections to external services working
  ☐ Agent starts successfully

After deployment:
  ☐ Bot responds to /help command
  ☐ Test audit completes successfully
  ☐ "Officially Verified" marker appears
  ☐ Audit logs show in Moltbook dashboard
  ☐ Metrics dashboard shows healthy agent

═════════════════════════════════════════════════════════════════════════════

🆘 TROUBLESHOOTING

Problem: "Invalid configuration syntax"
Solution: Check JSON formatting - ensure all { and [ are closed properly

Problem: Telegram bot doesn't respond
Solution: Verify TELEGRAM_TOKEN in secrets and webhook is configured

Problem: "JWT token generation failed"
Solution: Make sure AGENT_PRIVATE_KEY is set in Railway environment

Problem: Audits not appearing in Moltbook marketplace
Solution: Check integrations.moltbook.marketplace.publishAudits = true

═════════════════════════════════════════════════════════════════════════════

📞 NEED HELP?

1. Check logs: app.molt.id → Dashboard → Logs
2. Verify config: python deploy_openclaw.py --validate
3. Review documentation: OPENCLAW_INTEGRATION.md
4. GitHub issues: https://github.com/Hans1132/integrity.molt/issues

═════════════════════════════════════════════════════════════════════════════
        """
        print(instructions)
    
    def print_quick_reference(self):
        """Print quick reference card"""
        ref = """
╔═══════════════════════════════════════════════════════════════════════════╗
║                    QUICK REFERENCE CARD                                   ║
╚═══════════════════════════════════════════════════════════════════════════╝

🤖 AGENT IDENTITY
─────────────────────────────────────────────────────────────────────────────
  Name:      integrity.molt Agent
  Wallet:    BFmkPKu2tS9RoMufgJUd9GyabzC91hriAbMS6Hmr8TX6
  NFT ID:    2tWPw22bqgLaLdYCwe7599f7guQudwKpCCta4gvhgZZy
  Domain:    integrity.molt
  Agent ID:  molt_78587c41ed99a3375022dc28

🔌 ENDPOINTS
─────────────────────────────────────────────────────────────────────────────
  Telegram:  @integrity_molt_bot
  API:       https://integrity-molt.railway.app
  Dashboard: https://app.molt.id/agents/integrity-molt
  Marketplace: https://app.molt.id/marketplace/security

💰 PRICING
─────────────────────────────────────────────────────────────────────────────
  Free: 20 audits/day (pattern analysis)
  Pro:  $0.03 per audit (GPT-4o analysis)

📊 AVAILABILITY
─────────────────────────────────────────────────────────────────────────────
  Uptime: 99.9% (Railway managed)
  Response: <15 seconds typical
  Support: 24/7 via agent auto-responses

🔐 SECURITY
─────────────────────────────────────────────────────────────────────────────
  Auth: JWT-Ed25519
  Verification: Metaplex Core NFT
  On-chain: Solana mainnet
  Signature: HMAC-SHA256

📂 IMPORTANT FILES
─────────────────────────────────────────────────────────────────────────────
  Config:        openclaw_agent_config.json
  Integration:   OPENCLAW_INTEGRATION.md
  Main code:     src/agent.py
  Bot code:      src/telegram_bot.py
  Auditor:       src/security_auditor.py
  Agent config:  src/agent_config.py

🧪 TEST COMMANDS
─────────────────────────────────────────────────────────────────────────────
  /help
  /audit <address>
  /audit <address> --force
  /history

═════════════════════════════════════════════════════════════════════════════
        """
        print(ref)


def main():
    import argparse
    
    parser = argparse.ArgumentParser(
        description="OpenClaw Agent Deployment Helper"
    )
    parser.add_argument("--validate", action="store_true", help="Validate config")
    parser.add_argument("--export-secrets", action="store_true", help="Show secrets to update")
    parser.add_argument("--instructions", action="store_true", help="Print deployment guide")
    parser.add_argument("--quick-ref", action="store_true", help="Print quick reference")
    
    args = parser.parse_args()
    deployer = OpenClawDeployer()
    
    print("\n🦞 INTEGRITY.MOLT OPENCLAW DEPLOYER\n")
    print("   Configuration: openclaw_agent_config.json")
    print("   Status: Ready for deployment to app.molt.id\n")
    
    if args.validate:
        success = deployer.validate_config()
        sys.exit(0 if success else 1)
    
    elif args.export_secrets:
        deployer.export_secrets_template()
    
    elif args.instructions:
        deployer.print_deployment_instructions()
    
    elif args.quick_ref:
        deployer.print_quick_reference()
    
    else:
        # Default: show quick reference
        deployer.print_quick_reference()
        print("\n💡 TIP: Run with --instructions for full deployment guide")
        print("         Run with --export-secrets to see what to update")
        print("         Run with --validate to check configuration\n")


if __name__ == "__main__":
    main()
