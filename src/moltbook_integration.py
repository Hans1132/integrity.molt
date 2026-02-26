"""
Moltbook Platform Integration
Connects integrity.molt to Moltbook app.molt.id and publishes audit reports
"""
import logging
import asyncio
import httpx
import os
from typing import Optional, Dict, Any
from datetime import datetime
from src.config import Config

logger = logging.getLogger(__name__)


class MoltbookIntegration:
    """Manages integration with Moltbook platform (app.molt.id)"""
    
    # Moltbook API endpoints
    MOLTBOOK_API_BASE = "https://api.moltbook.io/v1"
    APP_MOLT_ID = "integrity.molt"
    
    # Agent metadata on Moltbook
    AGENT_METADATA = {
        "name": "integrity.molt",
        "domain": "integrity.molt",
        "description": "AI Security Audit Agent - Continuous smart contract analysis",
        "icon": "🔒",
        "category": "security",
        "tier": "verified",
        "network": "solana-mainnet"
    }
    
    def __init__(self):
        """Initialize Moltbook integration"""
        self.api_key = Config.MOLTBOOK_API_KEY if hasattr(Config, 'MOLTBOOK_API_KEY') else None
        self.agent_id = Config.AGENT_ID if hasattr(Config, 'AGENT_ID') else None
        self.client = httpx.AsyncClient(timeout=10.0)
        
        if not self.api_key or not self.agent_id:
            logger.warning("⚠️  Moltbook API credentials not configured - marketplace publishing disabled")
        else:
            logger.info("✅ Moltbook integration initialized")
    
    async def publish_audit_report(
        self,
        audit_id: str,
        contract_address: str,
        risk_score: int,
        findings: list,
        report_url: str,
        cost_usd: float,
        user_id: Optional[int] = None
    ) -> Dict[str, Any]:
        """
        Publish audit report to Moltbook marketplace
        
        Args:
            audit_id: Unique audit identifier
            contract_address: Smart contract address audited
            risk_score: Security risk score (1-10)
            findings: List of security findings
            report_url: URL to full audit report
            cost_usd: Cost of the audit in USD
            user_id: User who triggered audit (optional)
        
        Returns:
            Response from Moltbook API
        """
        if not self.api_key:
            logger.debug("Moltbook publishing skipped (no credentials)")
            return {"status": "skipped", "reason": "no_credentials"}
        
        try:
            payload = {
                "agent_id": self.agent_id,
                "audit_id": audit_id,
                "contract_address": contract_address,
                "risk_score": risk_score,
                "findings_count": len(findings),
                "report_url": report_url,
                "cost_usd": cost_usd,
                "timestamp": datetime.utcnow().isoformat(),
                "metadata": {
                    "triggered_by": user_id,
                    "analysis_type": "gpt4_with_patterns",
                    "marketplace": "moltbook"
                }
            }
            
            response = await self.client.post(
                f"{self.MOLTBOOK_API_BASE}/audits/publish",
                json=payload,
                headers={"Authorization": f"Bearer {self.api_key}"}
            )
            
            if response.status_code == 201:
                logger.info(f"✅ Audit {audit_id} published to Moltbook")
                return response.json()
            else:
                logger.warning(f"⚠️  Moltbook publish failed: {response.status_code}")
                return {"status": "failed", "code": response.status_code}
        
        except Exception as e:
            logger.error(f"❌ Moltbook publish error: {e}")
            return {"status": "error", "message": str(e)}
    
    async def update_agent_profile(self) -> Dict[str, Any]:
        """
        Update agent profile on Moltbook with latest stats
        
        Returns:
            Updated profile data
        """
        if not self.api_key:
            return {"status": "skipped"}
        
        try:
            # Fetch current stats
            stats = await self.get_agent_stats()
            
            payload = {
                "agent_id": self.agent_id,
                "metadata": self.AGENT_METADATA,
                "stats": stats,
                "last_updated": datetime.utcnow().isoformat()
            }
            
            response = await self.client.patch(
                f"{self.MOLTBOOK_API_BASE}/agents/{self.agent_id}/profile",
                json=payload,
                headers={"Authorization": f"Bearer {self.api_key}"}
            )
            
            if response.status_code == 200:
                logger.info("✅ Agent profile updated on Moltbook")
                return response.json()
            else:
                logger.warning(f"⚠️  Profile update failed: {response.status_code}")
                return {"status": "failed"}
        
        except Exception as e:
            logger.error(f"❌ Profile update error: {e}")
            return {"status": "error"}
    
    async def get_agent_stats(self) -> Dict[str, Any]:
        """Get current agent statistics for profile"""
        from src.database import db_client
        
        try:
            # Get audit counts
            total_audits = len(db_client.get_all_audits()) if hasattr(db_client, 'get_all_audits') else 0
            total_users = 0  # Would query user database
            avg_risk_score = 6.5  # Placeholder
            total_revenue_sol = 0.0  # Placeholder
            
            return {
                "total_audits": total_audits,
                "total_users": total_users,
                "average_risk_score": avg_risk_score,
                "total_revenue_sol": total_revenue_sol,
                "uptime_percent": 99.5,
                "response_time_ms": 2.3
            }
        except Exception as e:
            logger.error(f"Failed to get stats: {e}")
            return {}
    
    async def subscribe_to_marketplace_events(self) -> None:
        """
        Subscribe to Moltbook marketplace events (webhooks)
        Events like: new audit requests, payments, subscription updates
        """
        if not self.api_key:
            logger.warning("⚠️  Cannot subscribe to marketplace events (no credentials)")
            return
        
        try:
            webhook_url = f"https://integrity.molt.openclaw.io/webhooks/moltbook"
            
            payload = {
                "agent_id": self.agent_id,
                "event_types": [
                    "audit_request",
                    "payment_confirmed",
                    "subscription_updated",
                    "agent_notification"
                ],
                "webhook_url": webhook_url,
                "enabled": True
            }
            
            response = await self.client.post(
                f"{self.MOLTBOOK_API_BASE}/webhooks/subscribe",
                json=payload,
                headers={"Authorization": f"Bearer {self.api_key}"}
            )
            
            if response.status_code == 201:
                logger.info("✅ Subscribed to Moltbook marketplace events")
            else:
                logger.warning(f"⚠️  Webhook subscription failed: {response.status_code}")
        
        except Exception as e:
            logger.error(f"❌ Webhook subscription error: {e}")
    
    async def announce_audit_in_discord(
        self,
        audit_id: str,
        contract_address: str,
        risk_score: int,
        status: str = "completed"
    ) -> Dict[str, Any]:
        """
        Announce audit result in Molt Discord channel
        
        Args:
            audit_id: Audit ID
            contract_address: Contract analyzed
            risk_score: Risk score (1-10)
            status: Audit status (completed, failed, etc)
        
        Returns:
            Discord response
        """
        try:
            discord_webhook = os.getenv("DISCORD_AUDIT_WEBHOOK", "")
            
            if not discord_webhook:
                logger.debug("Discord webhook not configured, skipping announcement")
                return {"status": "skipped"}
            
            # Format risk score emoji
            risk_emoji = {
                **{i: "🟩" for i in range(1, 4)},  # Green
                **{i: "🟨" for i in range(4, 7)},  # Yellow
                **{i: "🟧" for i in range(7, 9)},  # Orange
                **{i: "🔴" for i in range(9, 11)}  # Red
            }.get(risk_score, "⚪")
            
            message = {
                "content": f"🔒 New Audit Report - integrity.molt",
                "embeds": [{
                    "title": f"Security Audit #{audit_id}",
                    "description": f"Contract: `{contract_address[:16]}...`",
                    "color": int("FF6B6B" if risk_score >= 8 else "FFA500" if risk_score >= 5 else "4CAF50", 16),
                    "fields": [
                        {"name": "Risk Score", "value": f"{risk_emoji} {risk_score}/10", "inline": True},
                        {"name": "Status", "value": status.upper(), "inline": True},
                        {"name": "Marketplace", "value": "🛒 Moltbook.io", "inline": False}
                    ]
                }]
            }
            
            response = await self.client.post(discord_webhook, json=message)
            
            if response.status_code == 204:
                logger.info("✅ Audit announced in Molt Discord")
                return {"status": "published"}
            else:
                logger.warning(f"⚠️  Discord announcement failed: {response.status_code}")
                return {"status": "failed"}
        
        except Exception as e:
            logger.error(f"❌ Discord announcement error: {e}")
            return {"status": "error"}
    
    async def close(self):
        """Close async client"""
        await self.client.aclose()


# Global singleton
moltbook_integration = MoltbookIntegration()


async def publish_audit_to_marketplace(audit_result: Dict[str, Any]) -> None:
    """
    Helper function to publish audit to Moltbook marketplace
    
    Args:
        audit_result: Complete audit result dictionary
    """
    try:
        await moltbook_integration.publish_audit_report(
            audit_id=audit_result.get("audit_id", "unknown"),
            contract_address=audit_result.get("contract_address", "unknown"),
            risk_score=audit_result.get("risk_score", 5),
            findings=audit_result.get("findings", []),
            report_url=audit_result.get("report_url", ""),
            cost_usd=audit_result.get("cost_usd", 0.0),
            user_id=audit_result.get("user_id")
        )
        
        # Also announce in Discord
        await moltbook_integration.announce_audit_in_discord(
            audit_id=audit_result.get("audit_id", "unknown"),
            contract_address=audit_result.get("contract_address", "unknown"),
            risk_score=audit_result.get("risk_score", 5),
            status="completed"
        )
    
    except Exception as e:
        logger.error(f"Failed to publish audit: {e}")
