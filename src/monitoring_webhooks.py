"""
Monitoring Webhook Server
Handles incoming monitoring requests and pushes telemetry data
"""
import logging
import os
import asyncio
from typing import Dict, Any, Optional
from datetime import datetime

logger = logging.getLogger(__name__)


class MonitoringWebhookServer:
    """Webhook server for monitoring integration"""
    
    def __init__(self):
        self.webhook_url = os.getenv("MONITORING_WEBHOOK_URL", "")
        self.webhook_secret = os.getenv("MONITORING_WEBHOOK_SECRET", "")
        self.enabled = bool(self.webhook_url)
    
    async def handle_monitoring_request(self, request_type: str, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle incoming monitoring webhook request"""
        
        if request_type == "metrics_request":
            return await self._send_metrics()
        
        elif request_type == "health_check":
            return await self._send_health_status()
        
        elif request_type == "alert_config":
            return await self._send_alert_config()
        
        else:
            logger.warning(f"Unknown monitoring request type: {request_type}")
            return {"status": "error", "message": "Unknown request type"}
    
    async def _send_metrics(self) -> Dict[str, Any]:
        """Package and send metrics"""
        try:
            from src.telemetry import telemetry
            
            metrics = telemetry.get_metrics()
            
            return {
                "status": "success",
                "data": metrics,
                "timestamp": datetime.utcnow().isoformat()
            }
        except Exception as e:
            logger.error(f"Error sending metrics: {e}")
            return {"status": "error", "message": str(e)}
    
    async def _send_health_status(self) -> Dict[str, Any]:
        """Package and send health status"""
        try:
            from src.telemetry import telemetry
            from src.health_router import HealthRouter
            
            health = await HealthRouter.health_check()
            
            return {
                "status": "success",
                "data": health,
                "timestamp": datetime.utcnow().isoformat()
            }
        except Exception as e:
            logger.error(f"Error sending health status: {e}")
            return {"status": "error", "message": str(e)}
    
    async def _send_alert_config(self) -> Dict[str, Any]:
        """Package and send alert configuration"""
        try:
            from src.telemetry import telemetry
            
            alert_manager = telemetry.alert_manager
            
            return {
                "status": "success",
                "critical_thresholds": alert_manager.CRITICAL_THRESHOLDS,
                "warning_thresholds": alert_manager.WARNING_THRESHOLDS,
                "current_alerts": alert_manager.active_alerts,
                "timestamp": datetime.utcnow().isoformat()
            }
        except Exception as e:
            logger.error(f"Error sending alert config: {e}")
            return {"status": "error", "message": str(e)}
    
    async def push_metrics(self) -> Optional[bool]:
        """Proactively push metrics to webhook"""
        if not self.enabled:
            return None
        
        try:
            import httpx
            
            from src.telemetry import telemetry
            
            metrics = telemetry.get_metrics()
            
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(
                    self.webhook_url,
                    json={
                        "type": "metrics_push",
                        "data": metrics,
                        "timestamp": datetime.utcnow().isoformat(),
                        "secret": self.webhook_secret
                    }
                )
                
                if response.status_code in (200, 202):
                    logger.debug(f"✅ Metrics pushed to webhook")
                    return True
                else:
                    logger.warning(f"⚠️  Webhook push failed: {response.status_code}")
                    return False
        
        except Exception as e:
            logger.debug(f"Webhook push error (non-blocking): {e}")
            return False
    
    async def push_alert(self, alert_level: str, alert_data: Dict[str, Any]) -> Optional[bool]:
        """Push alert to webhook immediately"""
        if not self.enabled:
            return None
        
        try:
            import httpx
            
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(
                    self.webhook_url,
                    json={
                        "type": "alert",
                        "level": alert_level,
                        "data": alert_data,
                        "timestamp": datetime.utcnow().isoformat(),
                        "secret": self.webhook_secret
                    }
                )
                
                if response.status_code in (200, 202):
                    logger.info(f"✅ {alert_level} alert pushed to webhook")
                    return True
                else:
                    logger.warning(f"⚠️  Alert push failed: {response.status_code}")
                    return False
        
        except Exception as e:
            logger.warning(f"Alert push error: {e}")
            return False


class MetricsScheduler:
    """Schedule periodic metric collection and export"""
    
    def __init__(self):
        self.webhook_server = MonitoringWebhookServer()
        self.export_interval = int(os.getenv("METRICS_EXPORT_INTERVAL_SECONDS", "300"))  # 5 min default
        self.running = False
    
    async def start(self) -> None:
        """Start the metrics scheduler"""
        self.running = True
        logger.info(f"🔄 Metrics scheduler started (interval: {self.export_interval}s)")
        
        try:
            while self.running:
                await asyncio.sleep(self.export_interval)
                
                # Push metrics periodically
                await self.webhook_server.push_metrics()
                
                # Check for alerts
                from src.telemetry import telemetry
                
                alerts = telemetry.alert_manager.check_alerts()
                
                for alert in alerts:
                    if alert.get("new"):
                        # Only push new alerts
                        await self.webhook_server.push_alert(
                            alert_level=alert.get("level", "WARNING"),
                            alert_data=alert
                        )
        
        except asyncio.CancelledError:
            logger.info("✋ Metrics scheduler stopped")
            self.running = False
        except Exception as e:
            logger.error(f"❌ Metrics scheduler error: {e}")
            self.running = False
    
    async def stop(self) -> None:
        """Stop the metrics scheduler"""
        self.running = False
        logger.info("🛑 Stopping metrics scheduler")


class AlertWebhookDispatcher:
    """Dispatch alerts to configured webhooks"""
    
    @staticmethod
    async def send_alert_to_slack(alert: Dict[str, Any]) -> bool:
        """Send alert to Slack webhook"""
        try:
            import httpx
            
            slack_webhook = os.getenv("SLACK_ALERT_WEBHOOK", "")
            if not slack_webhook:
                return False
            
            # Format alert for Slack
            color = "danger" if alert.get("level") == "CRITICAL" else "warning"
            
            slack_message = {
                "attachments": [
                    {
                        "color": color,
                        "title": f"🚨 {alert.get('level', 'ALERT')}: {alert.get('name', 'Unknown')}",
                        "text": alert.get("message", "No message"),
                        "fields": [
                            {
                                "title": "Current Value",
                                "value": str(alert.get("current_value")),
                                "short": True
                            },
                            {
                                "title": "Threshold",
                                "value": str(alert.get("threshold")),
                                "short": True
                            }
                        ],
                        "footer": "integrity.molt monitoring",
                        "ts": int(datetime.utcnow().timestamp())
                    }
                ]
            }
            
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.post(slack_webhook, json=slack_message)
                
                if response.status_code == 200:
                    logger.info(f"✅ Alert sent to Slack: {alert.get('name')}")
                    return True
            
            return False
        
        except Exception as e:
            logger.debug(f"Slack alert error (non-blocking): {e}")
            return False
    
    @staticmethod
    async def send_alert_to_email(alert: Dict[str, Any]) -> bool:
        """Send alert to email via SMTP"""
        try:
            import smtplib
            from email.mime.text import MIMEText
            from email.mime.multipart import MIMEMultipart
            
            smtp_server = os.getenv("SMTP_SERVER", "")
            smtp_port = int(os.getenv("SMTP_PORT", "587"))
            smtp_user = os.getenv("SMTP_USER", "")
            smtp_password = os.getenv("SMTP_PASSWORD", "")
            alert_email = os.getenv("ALERT_EMAIL", "")
            
            if not all([smtp_server, smtp_user, smtp_password, alert_email]):
                return False
            
            # Format email
            subject = f"[{alert.get('level')}] {alert.get('name', 'Alert')}"
            body = f"""
            integrity.molt Alert
            =====================
            
            Level: {alert.get('level')}
            Name: {alert.get('name')}
            Message: {alert.get('message')}
            
            Current Value: {alert.get('current_value')}
            Threshold: {alert.get('threshold')}
            
            Time: {datetime.utcnow().isoformat()}
            """
            
            msg = MIMEMultipart()
            msg["From"] = smtp_user
            msg["To"] = alert_email
            msg["Subject"] = subject
            msg.attach(MIMEText(body, "plain"))
            
            # Send email
            with smtplib.SMTP(smtp_server, smtp_port) as server:
                server.starttls()
                server.login(smtp_user, smtp_password)
                server.send_message(msg)
            
            logger.info(f"✅ Alert sent to email: {alert.get('name')}")
            return True
        
        except Exception as e:
            logger.debug(f"Email alert error (non-blocking): {e}")
            return False
    
    @staticmethod
    async def send_alert_to_discord(alert: Dict[str, Any]) -> bool:
        """Send alert to Discord webhook"""
        try:
            import httpx
            
            discord_webhook = os.getenv("DISCORD_ALERT_WEBHOOK", "")
            if not discord_webhook:
                return False
            
            # Format alert for Discord
            embed = {
                "title": f"🚨 {alert.get('level')}: {alert.get('name', 'Unknown')}",
                "description": alert.get("message", "No message"),
                "color": 16711680 if alert.get("level") == "CRITICAL" else 16765440,  # Red or Orange
                "fields": [
                    {
                        "name": "Current Value",
                        "value": str(alert.get("current_value")),
                        "inline": True
                    },
                    {
                        "name": "Threshold",
                        "value": str(alert.get("threshold")),
                        "inline": True
                    }
                ],
                "footer": {
                    "text": "integrity.molt monitoring"
                },
                "timestamp": datetime.utcnow().isoformat()
            }
            
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.post(
                    discord_webhook,
                    json={"embeds": [embed]}
                )
                
                if response.status_code == 204:
                    logger.info(f"✅ Alert sent to Discord: {alert.get('name')}")
                    return True
            
            return False
        
        except Exception as e:
            logger.debug(f"Discord alert error (non-blocking): {e}")
            return False


# Global instances
webhook_server = MonitoringWebhookServer()
metrics_scheduler = MetricsScheduler()
alert_dispatcher = AlertWebhookDispatcher()

logger.info("📡 Monitoring webhooks initialized")
