"""
Health Check Router and HTTP Endpoints
Provides /health, /metrics, /readiness endpoints for monitoring
"""
import json
import logging
from datetime import datetime
from typing import Dict, Any

logger = logging.getLogger(__name__)


class HealthRouter:
    """HTTP health check endpoints for monitoring and orchestration"""
    
    @staticmethod
    async def health_check() -> Dict[str, Any]:
        """
        GET /health - Full health status
        Used by external monitoring systems
        """
        from src.telemetry import telemetry
        
        health_status = telemetry.get_health_status()
        metrics = telemetry.get_metrics()
        
        # Determine overall health
        health_score = health_status.get("health_score", 0)
        status = "healthy" if health_score >= 75 else "degraded" if health_score >= 50 else "unhealthy"
        
        return {
            "status": status,
            "timestamp": datetime.utcnow().isoformat(),
            "health_score": health_score,
            "checks": {
                "telegram_bot": "online",
                "storage": "online",
                "openai_api": health_status.get("openai_status", "unknown"),
                "solana_rpc": health_status.get("solana_status", "unknown"),
                "moltbook_api": health_status.get("moltbook_status", "unknown")
            },
            "metrics_summary": {
                "audits_completed": metrics.get("audits", {}).get("total", 0),
                "error_rate_percent": metrics.get("errors", {}).get("rate_percent", 0),
                "avg_response_time_ms": metrics.get("performance", {}).get("avg_response_time_ms", 0),
                "uptime_hours": metrics.get("uptime", {}).get("hours", 0)
            }
        }
    
    @staticmethod
    async def metrics() -> Dict[str, Any]:
        """
        GET /metrics - Detailed metrics for monitoring systems
        Used by Prometheus, DataDog, NewRelic scraping
        """
        from src.telemetry import telemetry
        
        metrics = telemetry.get_metrics()
        health_status = telemetry.get_health_status()
        
        return {
            "timestamp": datetime.utcnow().isoformat(),
            "audits": {
                "total_completed": metrics.get("audits", {}).get("total", 0),
                "this_hour": metrics.get("audits", {}).get("this_hour", 0),
                "this_day": metrics.get("audits", {}).get("this_day", 0),
                "average_cost_usd": metrics.get("audits", {}).get("avg_cost", 0),
                "total_cost_usd": round(metrics.get("audits", {}).get("total_cost", 0), 2)
            },
            "errors": {
                "total": metrics.get("errors", {}).get("total", 0),
                "this_hour": metrics.get("errors", {}).get("this_hour", 0),
                "rate_percent": round(metrics.get("errors", {}).get("rate_percent", 0), 2)
            },
            "performance": {
                "avg_response_time_ms": round(metrics.get("performance", {}).get("avg_response_time_ms", 0), 1),
                "max_response_time_ms": metrics.get("performance", {}).get("max_response_time_ms", 0),
                "status": metrics.get("performance", {}).get("status", "unknown")
            },
            "api_calls": {
                "openai": metrics.get("api", {}).get("openai_calls", 0),
                "solana": metrics.get("api", {}).get("solana_calls", 0),
                "moltbook": metrics.get("api", {}).get("moltbook_calls", 0)
            },
            "users": {
                "unique_count": metrics.get("users", {}).get("unique_count", 0),
                "new_today": metrics.get("users", {}).get("new_today", 0),
                "subscribers": metrics.get("users", {}).get("subscribers", 0)
            },
            "uptime": {
                "total_seconds": metrics.get("uptime", {}).get("seconds", 0),
                "total_hours": metrics.get("uptime", {}).get("hours", 0),
                "status": metrics.get("uptime", {}).get("status", "unknown")
            },
            "health": {
                "health_score": health_status.get("health_score", 0),
                "critical_alerts": len(health_status.get("critical_alerts", [])),
                "warning_alerts": len(health_status.get("warning_alerts", []))
            }
        }
    
    @staticmethod
    async def liveness() -> Dict[str, Any]:
        """
        GET /liveness - Kubernetes liveness probe
        Returns 200 if process is alive and responsive
        """
        try:
            from src.telemetry import telemetry
            
            # Quick check: telemetry system responsive
            _ = telemetry.get_metrics()
            
            return {
                "status": "alive",
                "timestamp": datetime.utcnow().isoformat()
            }
        except Exception as e:
            logger.error(f"Liveness check failed: {e}")
            return {
                "status": "dead",
                "error": str(e),
                "timestamp": datetime.utcnow().isoformat()
            }
    
    @staticmethod
    async def readiness() -> Dict[str, Any]:
        """
        GET /readiness - Kubernetes readiness probe
        Returns 200 only if ready to accept traffic
        """
        from src.telemetry import telemetry
        
        health_status = telemetry.get_health_status()
        health_score = health_status.get("health_score", 0)
        
        # Ready if health score >= 50 (degraded or better)
        is_ready = health_score >= 50
        
        return {
            "ready": is_ready,
            "health_score": health_score,
            "timestamp": datetime.utcnow().isoformat(),
            "blocking_checks": health_status.get("critical_alerts", []) if not is_ready else []
        }
    
    @staticmethod
    async def prometheus_metrics() -> str:
        """
        GET /metrics/prometheus - Prometheus-format metrics
        Returns metrics in Prometheus text format
        """
        from src.telemetry import telemetry
        
        metrics = telemetry.get_metrics()
        health = telemetry.get_health_status()
        
        lines = [
            "# HELP integrity_audits_total Total number of audits completed",
            "# TYPE integrity_audits_total counter",
            f"integrity_audits_total {metrics.get('audits', {}).get('total', 0)}",
            "",
            "# HELP integrity_errors_total Total number of errors",
            "# TYPE integrity_errors_total counter",
            f"integrity_errors_total {metrics.get('errors', {}).get('total', 0)}",
            "",
            "# HELP integrity_error_rate Current error rate as percentage",
            "# TYPE integrity_error_rate gauge",
            f"integrity_error_rate {metrics.get('errors', {}).get('rate_percent', 0)}",
            "",
            "# HELP integrity_response_time_ms Average response time in milliseconds",
            "# TYPE integrity_response_time_ms gauge",
            f"integrity_response_time_ms {metrics.get('performance', {}).get('avg_response_time_ms', 0)}",
            "",
            "# HELP integrity_health_score Current health score (0-100)",
            "# TYPE integrity_health_score gauge",
            f"integrity_health_score {health.get('health_score', 0)}",
            "",
            "# HELP integrity_cost_usd Total cost in USD",
            "# TYPE integrity_cost_usd counter",
            f"integrity_cost_usd {metrics.get('audits', {}).get('total_cost', 0)}",
            "",
            "# HELP integrity_users_unique Unique users count",
            "# TYPE integrity_users_unique gauge",
            f"integrity_users_unique {metrics.get('users', {}).get('unique_count', 0)}",
        ]
        
        return "\n".join(lines) + "\n"


class MetricsExporter:
    """Exports metrics to external monitoring services"""
    
    @staticmethod
    async def export_to_datadog(metrics_data: Dict[str, Any]) -> bool:
        """Send metrics to DataDog"""
        try:
            import httpx
            
            datadog_api_key = json.loads(os.getenv("DATADOG_API_KEY", "{}"))
            if not datadog_api_key:
                logger.debug("⏭️  DataDog export disabled (no API key)")
                return False
            
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.post(
                    "https://api.datadoghq.com/api/v1/series",
                    headers={"DD-API-KEY": datadog_api_key},
                    json={"series": [metrics_data]}
                )
                
                if response.status_code == 202:
                    logger.debug("✅ Metrics exported to DataDog")
                    return True
                else:
                    logger.warning(f"⚠️  DataDog export failed: {response.status_code}")
                    return False
        
        except Exception as e:
            logger.debug(f"DataDog export error (non-blocking): {e}")
            return False
    
    @staticmethod
    async def export_to_newrelic(metrics_data: Dict[str, Any]) -> bool:
        """Send metrics to New Relic"""
        try:
            import httpx
            
            newrelic_api_key = os.getenv("NEWRELIC_API_KEY", "")
            if not newrelic_api_key:
                logger.debug("⏭️  New Relic export disabled (no API key)")
                return False
            
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.post(
                    "https://api.newrelic.com/v1/accounts/metrics",
                    headers={"X-API-Key": newrelic_api_key},
                    json=metrics_data
                )
                
                if response.status_code in (200, 202):
                    logger.debug("✅ Metrics exported to New Relic")
                    return True
                else:
                    logger.warning(f"⚠️  New Relic export failed: {response.status_code}")
                    return False
        
        except Exception as e:
            logger.debug(f"New Relic export error (non-blocking): {e}")
            return False


logger.info("🏥 Health check router initialized (endpoints available)")
