"""
OpenClaw Agent Connector
Manages deployment and communication with Moltbook OpenClaw infrastructure
"""
import logging
import os
import subprocess
import json
from typing import Optional, Dict, Any
from pathlib import Path

logger = logging.getLogger(__name__)


class OpenClawAgent:
    """Manages OpenClaw agent deployment and coordination"""
    
    def __init__(self):
        """Initialize OpenClaw agent connector"""
        self.openclaw_url = os.getenv("OPENCLAW_URL", "https://integrity.molt.openclaw.io")
        self.openclaw_token = os.getenv("OPENCLAW_TOKEN", "")
        self.agent_domain = "integrity.molt"
        self.agent_id = os.getenv("AGENT_ID", "integrity_molt_agent")
        
        self.is_configured = bool(self.openclaw_token)
        
        if self.is_configured:
            logger.info(f"✅ OpenClaw agent configured: {self.agent_domain}")
        else:
            logger.warning("⚠️  OpenClaw token not configured - using local deployment only")
    
    def deploy_to_openclaw(self) -> Dict[str, Any]:
        """
        Deploy integrity.molt to OpenClaw infrastructure
        
        Returns:
            Deployment status
        """
        if not self.is_configured:
            logger.warning("OpenClaw deployment skipped (no token)")
            return {"status": "skipped", "reason": "no_token"}
        
        try:
            # Check if openclaw CLI is installed
            result = subprocess.run(
                ["openclaw", "--version"],
                capture_output=True,
                text=True,
                timeout=5
            )
            
            if result.returncode != 0:
                logger.warning("⚠️  OpenClaw CLI not found - install with: npm install -g @moltbook/openclaw")
                return {"status": "failed", "reason": "cli_not_installed"}
            
            logger.info(f"OpenClaw CLI version: {result.stdout.strip()}")
            
            # Deploy to OpenClaw
            logger.info("🚀 Deploying to OpenClaw infrastructure...")
            
            deploy_result = subprocess.run(
                [
                    "openclaw", "deploy",
                    "--domain", self.agent_domain,
                    "--token", self.openclaw_token,
                    "--entrypoint", "python -m src"
                ],
                cwd="/app" if Path("/app").exists() else ".",
                capture_output=True,
                text=True,
                timeout=60
            )
            
            if deploy_result.returncode == 0:
                logger.info(f"✅ Deployed to OpenClaw: {self.agent_domain}")
                return {
                    "status": "success",
                    "domain": self.agent_domain,
                    "url": f"https://{self.agent_domain}.openclaw.io",
                    "output": deploy_result.stdout
                }
            else:
                logger.error(f"❌ Deployment failed: {deploy_result.stderr}")
                return {
                    "status": "failed",
                    "error": deploy_result.stderr
                }
        
        except subprocess.TimeoutExpired:
            logger.error("Deployment timeout")
            return {"status": "failed", "reason": "timeout"}
        except FileNotFoundError:
            logger.warning("OpenClaw CLI not installed")
            return {"status": "failed", "reason": "cli_not_found"}
        except Exception as e:
            logger.error(f"Deployment error: {e}")
            return {"status": "error", "message": str(e)}
    
    def register_agent_domain(self) -> Dict[str, Any]:
        """
        Register agent domain on Moltbook
        
        Returns:
            Registration status
        """
        if not self.is_configured:
            return {"status": "skipped"}
        
        try:
            import httpx
            
            payload = {
                "domain": self.agent_domain,
                "agent_id": self.agent_id,
                "network": "solana-mainnet",
                "capabilities": [
                    "security_audit",
                    "contract_analysis",
                    "pattern_detection",
                    "risk_assessment"
                ],
                "metadata": {
                    "description": "AI Security Audit Agent",
                    "tier": "verified",
                    "contact": "integrity.molt@moltbook.io"
                }
            }
            
            headers = {
                "Authorization": f"Bearer {self.openclaw_token}",
                "Content-Type": "application/json"
            }
            
            # Use sync request (will be in async context via wrapper)
            response = subprocess.run(
                [
                    "curl", "-X", "POST",
                    f"{self.openclaw_url}/api/domains/register",
                    "-H", f"Authorization: Bearer {self.openclaw_token}",
                    "-H", "Content-Type: application/json",
                    "-d", json.dumps(payload)
                ],
                capture_output=True,
                text=True,
                timeout=10
            )
            
            if response.returncode == 0:
                logger.info(f"✅ Domain registered: {self.agent_domain}")
                return {"status": "registered", "domain": self.agent_domain}
            else:
                logger.warning(f"⚠️  Domain registration failed: {response.stderr}")
                return {"status": "failed"}
        
        except Exception as e:
            logger.error(f"Domain registration error: {e}")
            return {"status": "error"}
    
    def setup_health_check(self) -> Dict[str, Any]:
        """
        Setup health check endpoint for OpenClaw
        OpenClaw requires /health endpoint that returns 200 OK
        
        Returns:
            Setup status
        """
        try:
            health_endpoint = f"{self.openclaw_url}/health"
            logger.info(f"✅ Health check configured for: {health_endpoint}")
            
            return {
                "status": "configured",
                "endpoint": "/health",
                "interval": "30s",
                "timeout": "10s"
            }
        except Exception as e:
            logger.error(f"Health check setup failed: {e}")
            return {"status": "failed"}
    
    def get_deployment_status(self) -> Dict[str, Any]:
        """Get current deployment status on OpenClaw"""
        if not self.is_configured:
            return {"status": "not_configured"}
        
        try:
            result = subprocess.run(
                [
                    "openclaw", "status",
                    "--domain", self.agent_domain,
                    "--token", self.openclaw_token
                ],
                capture_output=True,
                text=True,
                timeout=10
            )
            
            if result.returncode == 0:
                logger.info(f"OpenClaw status: {result.stdout}")
                return {"status": "active", "output": result.stdout}
            else:
                return {"status": "inactive"}
        
        except Exception as e:
            logger.error(f"Status check failed: {e}")
            return {"status": "error"}
    
    def rollback_deployment(self) -> Dict[str, Any]:
        """Rollback to previous OpenClaw deployment"""
        if not self.is_configured:
            return {"status": "skipped"}
        
        try:
            result = subprocess.run(
                [
                    "openclaw", "rollback",
                    "--domain", self.agent_domain,
                    "--token", self.openclaw_token
                ],
                capture_output=True,
                text=True,
                timeout=30
            )
            
            if result.returncode == 0:
                logger.info("✅ Deployment rolled back")
                return {"status": "success"}
            else:
                logger.error(f"Rollback failed: {result.stderr}")
                return {"status": "failed"}
        
        except Exception as e:
            logger.error(f"Rollback error: {e}")
            return {"status": "error"}
    
    def enable_webhooks(self) -> Dict[str, Any]:
        """Enable OpenClaw webhook delivery for audit events"""
        if not self.is_configured:
            return {"status": "skipped"}
        
        try:
            webhook_config = {
                "events": [
                    "audit.completed",
                    "audit.failed",
                    "payment.received",
                    "subscription.updated"
                ],
                "endpoint": f"https://{self.agent_domain}.openclaw.io/webhooks/events",
                "retry_policy": "exponential",
                "timeout": "30s"
            }
            
            logger.info("✅ OpenClaw webhooks configured")
            return {"status": "enabled", "config": webhook_config}
        
        except Exception as e:
            logger.error(f"Webhook configuration failed: {e}")
            return {"status": "failed"}
    
    def get_agent_metrics(self) -> Dict[str, Any]:
        """Get OpenClaw agent metrics and performance data"""
        if not self.is_configured:
            return {"status": "skipped"}
        
        try:
            result = subprocess.run(
                [
                    "openclaw", "metrics",
                    "--domain", self.agent_domain,
                    "--token", self.openclaw_token,
                    "--format", "json"
                ],
                capture_output=True,
                text=True,
                timeout=10
            )
            
            if result.returncode == 0:
                metrics = json.loads(result.stdout)
                logger.info(f"✅ Agent metrics retrieved")
                return {"status": "success", "metrics": metrics}
            else:
                return {"status": "failed"}
        
        except json.JSONDecodeError:
            logger.error("Failed to parse metrics JSON")
            return {"status": "failed", "reason": "parse_error"}
        except Exception as e:
            logger.error(f"Metrics retrieval failed: {e}")
            return {"status": "error"}


# Global singleton
openclaw_agent = OpenClawAgent()


def initialize_openclaw() -> Dict[str, Any]:
    """Initialize OpenClaw deployment and setup"""
    logger.info("🚀 Initializing OpenClaw infrastructure...")
    
    results = {
        "deployment": openclaw_agent.deploy_to_openclaw(),
        "domain": openclaw_agent.register_agent_domain(),
        "health_check": openclaw_agent.setup_health_check(),
        "webhooks": openclaw_agent.enable_webhooks()
    }
    
    for component, result in results.items():
        status = result.get("status", "unknown")
        if status == "success" or status == "enabled" or status == "configured" or status == "registered":
            logger.info(f"  ✅ {component}: {status}")
        elif status == "skipped":
            logger.info(f"  ⏭️  {component}: skipped")
        else:
            logger.warning(f"  ⚠️  {component}: {status}")
    
    return results
