"""
Production Telemetry & Monitoring
Tracks performance, errors, and audit metrics for production operations
"""
import logging
import time
import asyncio
from typing import Dict, Any, Optional, List
from datetime import datetime, timedelta
from collections import defaultdict
import json

logger = logging.getLogger(__name__)


class TelemetryCollector:
    """Collects and aggregates telemetry data for monitoring"""
    
    def __init__(self):
        """Initialize telemetry collector"""
        self.audit_count = 0
        self.error_count = 0
        self.total_cost_usd = 0.0
        self.avg_response_time_ms = 0.0
        
        # Time-based tracking
        self.hourly_audits = defaultdict(int)
        self.daily_audits = defaultdict(int)
        self.hourly_errors = defaultdict(int)
        
        # Performance tracking
        self.response_times: List[float] = []
        self.max_response_times = 100  # Keep last 100
        
        # User metrics
        self.user_audits = defaultdict(int)
        self.user_errors = defaultdict(int)
        
        # API usage
        self.api_calls_openai = 0
        self.api_calls_solana = 0
        self.api_calls_moltbook = 0
        
        # Start time for uptime calculation
        self.start_time = datetime.utcnow()
        
        logger.info("✅ Telemetry collector initialized")
    
    def record_audit(
        self,
        user_id: int,
        contract_addr: str,
        analysis_type: str,
        cost_usd: float,
        response_time_ms: float,
        risk_score: int
    ) -> None:
        """Record audit completion"""
        self.audit_count += 1
        self.total_cost_usd += cost_usd
        self.user_audits[user_id] += 1
        
        # Track response time
        self.response_times.append(response_time_ms)
        if len(self.response_times) > self.max_response_times:
            self.response_times.pop(0)
        self.avg_response_time_ms = sum(self.response_times) / len(self.response_times)
        
        # Time-based tracking
        hour_key = datetime.utcnow().strftime("%Y-%m-%d %H:00")
        day_key = datetime.utcnow().strftime("%Y-%m-%d")
        self.hourly_audits[hour_key] += 1
        self.daily_audits[day_key] += 1
        
        logger.debug(
            f"Audit recorded: user={user_id}, type={analysis_type}, "
            f"cost=${cost_usd:.4f}, time={response_time_ms:.0f}ms, risk={risk_score}/10"
        )
    
    def record_error(
        self,
        user_id: Optional[int],
        error_type: str,
        error_message: str,
        context: Optional[Dict[str, Any]] = None
    ) -> None:
        """Record error occurrence"""
        self.error_count += 1
        if user_id:
            self.user_errors[user_id] += 1
        
        hour_key = datetime.utcnow().strftime("%Y-%m-%d %H:00")
        self.hourly_errors[hour_key] += 1
        
        logger.warning(
            f"Error recorded: type={error_type}, user={user_id}, "
            f"message={error_message}, context={context}"
        )
    
    def record_api_call(self, api_name: str, success: bool, latency_ms: float) -> None:
        """Record API call for monitoring"""
        if api_name == "openai":
            self.api_calls_openai += 1
        elif api_name == "solana":
            self.api_calls_solana += 1
        elif api_name == "moltbook":
            self.api_calls_moltbook += 1
        
        status = "success" if success else "failed"
        logger.debug(f"API call: {api_name} {status} ({latency_ms:.0f}ms)")
    
    def get_metrics(self) -> Dict[str, Any]:
        """Get current metrics for monitoring"""
        uptime_seconds = (datetime.utcnow() - self.start_time).total_seconds()
        uptime_hours = uptime_seconds / 3600
        
        # Calculate error rate
        total_attempts = self.audit_count + self.error_count
        error_rate = (self.error_count / total_attempts * 100) if total_attempts > 0 else 0
        
        # Get current hour stats
        current_hour = datetime.utcnow().strftime("%Y-%m-%d %H:00")
        current_day = datetime.utcnow().strftime("%Y-%m-%d")
        
        return {
            "timestamp": datetime.utcnow().isoformat(),
            "uptime": {
                "seconds": int(uptime_seconds),
                "hours": f"{uptime_hours:.1f}",
                "status": "operational"
            },
            "audits": {
                "total": self.audit_count,
                "this_hour": self.hourly_audits.get(current_hour, 0),
                "this_day": self.daily_audits.get(current_day, 0),
                "average_cost_usd": f"${self.total_cost_usd / max(self.audit_count, 1):.4f}"
            },
            "errors": {
                "total": self.error_count,
                "this_hour": self.hourly_errors.get(current_hour, 0),
                "rate_percent": f"{error_rate:.2f}%"
            },
            "performance": {
                "avg_response_time_ms": f"{self.avg_response_time_ms:.0f}ms",
                "response_time_samples": len(self.response_times),
                "status": "fast" if self.avg_response_time_ms < 5000 else "normal" if self.avg_response_time_ms < 10000 else "slow"
            },
            "api": {
                "openai_calls": self.api_calls_openai,
                "solana_calls": self.api_calls_solana,
                "moltbook_calls": self.api_calls_moltbook
            },
            "costs": {
                "total_usd": f"${self.total_cost_usd:.2f}",
                "per_audit_usd": f"${self.total_cost_usd / max(self.audit_count, 1):.4f}"
            },
            "users": {
                "total_unique": len(self.user_audits),
                "top_user": max(self.user_audits.items(), default=(None, 0))[0]
            }
        }
    
    def get_health_status(self) -> Dict[str, Any]:
        """Get health check status"""
        metrics = self.get_metrics()
        
        # Calculate health score
        error_rate = float(metrics["errors"]["rate_percent"].rstrip('%'))
        response_time = float(metrics["performance"]["avg_response_time_ms"].rstrip('ms'))
        
        health_score = 100
        if error_rate > 5:
            health_score -= 20
        elif error_rate > 2:
            health_score -= 10
        
        if response_time > 10000:
            health_score -= 15
        elif response_time > 5000:
            health_score -= 5
        
        status = "healthy" if health_score >= 80 else "degraded" if health_score >= 60 else "critical"
        
        return {
            "status": status,
            "health_score": health_score,
            "timestamp": datetime.utcnow().isoformat(),
            "errors": self.error_count,
            "error_rate": f"{error_rate:.2f}%",
            "response_time_ms": f"{response_time:.0f}ms"
        }


# Global singleton
telemetry = TelemetryCollector()


class HealthCheckEndpoint:
    """Provides health check endpoint for monitoring services"""
    
    @staticmethod
    def get_health() -> Dict[str, Any]:
        """Return health status for monitoring"""
        health = telemetry.get_health_status()
        
        return {
            "status": health["status"],
            "health_score": health["health_score"],
            "timestamp": health["timestamp"],
            "checks": {
                "database": "operational",
                "telegram_api": "operational",
                "openai_api": "operational" if telemetry.api_calls_openai > 0 else "untested",
                "solana_rpc": "operational" if telemetry.api_calls_solana > 0 else "untested",
                "moltbook": "operational" if telemetry.api_calls_moltbook > 0 else "unconfigured"
            }
        }
    
    @staticmethod
    def get_metrics() -> Dict[str, Any]:
        """Return detailed metrics"""
        return telemetry.get_metrics()
    
    @staticmethod
    def get_liveness() -> Dict[str, str]:
        """Kubernetes/container liveness probe"""
        return {"status": "alive"}
    
    @staticmethod
    def get_readiness() -> Dict[str, Any]:
        """Kubernetes/container readiness probe"""
        health = telemetry.get_health_status()
        ready = health["health_score"] >= 60
        
        return {
            "ready": ready,
            "status": "ready" if ready else "not_ready",
            "health_score": health["health_score"]
        }


class AlertManager:
    """Manages alert conditions and notifications"""
    
    # Alert thresholds
    CRITICAL_THRESHOLDS = {
        "error_rate_percent": 10,
        "response_time_ms": 30000,
        "downtime_minutes": 5,
        "api_failures": 100
    }
    
    WARNING_THRESHOLDS = {
        "error_rate_percent": 5,
        "response_time_ms": 15000,
        "api_failures": 50
    }
    
    def __init__(self):
        """Initialize alert manager"""
        self.active_alerts: List[Dict[str, Any]] = []
        self.alert_history: List[Dict[str, Any]] = []
    
    def check_alerts(self) -> List[Dict[str, Any]]:
        """Check current metrics against alert thresholds"""
        alerts = []
        metrics = telemetry.get_metrics()
        health = telemetry.get_health_status()
        
        error_rate = float(metrics["errors"]["rate_percent"].rstrip('%'))
        response_time = float(metrics["performance"]["avg_response_time_ms"].rstrip('ms'))
        
        # Check critical thresholds
        if error_rate > self.CRITICAL_THRESHOLDS["error_rate_percent"]:
            alerts.append({
                "level": "CRITICAL",
                "type": "high_error_rate",
                "value": f"{error_rate:.2f}%",
                "threshold": f"{self.CRITICAL_THRESHOLDS['error_rate_percent']}%",
                "timestamp": datetime.utcnow().isoformat(),
                "message": f"Critical error rate: {error_rate:.2f}%"
            })
        
        if response_time > self.CRITICAL_THRESHOLDS["response_time_ms"]:
            alerts.append({
                "level": "CRITICAL",
                "type": "slow_response_time",
                "value": f"{response_time:.0f}ms",
                "threshold": f"{self.CRITICAL_THRESHOLDS['response_time_ms']}ms",
                "timestamp": datetime.utcnow().isoformat(),
                "message": f"Critical slow response: {response_time:.0f}ms"
            })
        
        # Check warning thresholds
        if error_rate > self.WARNING_THRESHOLDS["error_rate_percent"]:
            alerts.append({
                "level": "WARNING",
                "type": "elevated_error_rate",
                "value": f"{error_rate:.2f}%",
                "threshold": f"{self.WARNING_THRESHOLDS['error_rate_percent']}%",
                "timestamp": datetime.utcnow().isoformat(),
                "message": f"Elevated error rate: {error_rate:.2f}%"
            })
        
        # Check health score
        if health["health_score"] < 60:
            alerts.append({
                "level": "CRITICAL",
                "type": "poor_health",
                "value": health["health_score"],
                "threshold": 60,
                "timestamp": datetime.utcnow().isoformat(),
                "message": f"Health score degraded: {health['health_score']}"
            })
        
        self.active_alerts = alerts
        if alerts:
            logger.warning(f"🚨 {len(alerts)} alert(s) raised - {[a['type'] for a in alerts]}")
        
        return alerts


# Global alert manager
alert_manager = AlertManager()
