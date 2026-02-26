"""
Sentry Error Tracking Integration
Monitors, tracks, and reports errors to Sentry for production diagnostics
"""
import logging
import os
from typing import Optional, Dict, Any
import asyncio

logger = logging.getLogger(__name__)

# Try to import Sentry (optional dependency)
try:
    import sentry_sdk
    from sentry_sdk.integrations.logging import LoggingIntegration
    SENTRY_AVAILABLE = True
except ImportError:
    SENTRY_AVAILABLE = False
    logger.warning("⚠️  Sentry SDK not installed - error tracking disabled")


class SentryMonitor:
    """Integrates Sentry for error tracking and monitoring"""
    
    def __init__(self):
        """Initialize Sentry integration"""
        self.sentry_dsn = os.getenv("SENTRY_DSN", "")
        self.enabled = SENTRY_AVAILABLE and bool(self.sentry_dsn)
        
        if self.enabled:
            self._setup_sentry()
            logger.info("✅ Sentry error tracking enabled")
        else:
            logger.info("⏭️  Sentry error tracking disabled (no DSN configured)")
    
    def _setup_sentry(self) -> None:
        """Configure Sentry SDK"""
        if not SENTRY_AVAILABLE:
            return
        
        sentry_logging = LoggingIntegration(
            level=logging.INFO,        # Capture info and above as breadcrumbs
            event_level=logging.ERROR   # Send errors as events
        )
        
        sentry_sdk.init(
            dsn=self.sentry_dsn,
            integrations=[sentry_logging],
            traces_sample_rate=0.1,  # 10% of transactions
            environment=os.getenv("ENVIRONMENT", "development"),
            release=os.getenv("APP_VERSION", "unknown"),
            debug=False
        )
    
    def capture_exception(self, exception: Exception, context: Optional[Dict[str, Any]] = None) -> None:
        """Capture exception to Sentry"""
        if not self.enabled or not SENTRY_AVAILABLE:
            return
        
        try:
            with sentry_sdk.push_scope() as scope:
                if context:
                    for key, value in context.items():
                        scope.set_extra(key, value)
                
                sentry_sdk.capture_exception(exception)
                logger.info(f"✅ Exception captured in Sentry: {type(exception).__name__}")
        
        except Exception as e:
            logger.error(f"Failed to send to Sentry: {e}")
    
    def capture_message(self, message: str, level: str = "info", tags: Optional[Dict[str, str]] = None) -> None:
        """Send message to Sentry"""
        if not self.enabled or not SENTRY_AVAILABLE:
            return
        
        try:
            with sentry_sdk.push_scope() as scope:
                if tags:
                    for key, value in tags.items():
                        scope.set_tag(key, value)
                
                sentry_sdk.capture_message(message, level=level)
        
        except Exception as e:
            logger.error(f"Failed to send message to Sentry: {e}")
    
    def track_transaction(self, transaction_name: str, op: str = "http.client"):
        """Track performance transaction"""
        if not self.enabled or not SENTRY_AVAILABLE:
            return None
        
        return sentry_sdk.start_transaction(op=op, name=transaction_name)
    
    def set_user_context(self, user_id: int, user_dict: Optional[Dict[str, Any]] = None) -> None:
        """Set user context for error reporting"""
        if not self.enabled or not SENTRY_AVAILABLE:
            return
        
        user_context = user_dict or {}
        user_context["id"] = str(user_id)
        
        sentry_sdk.set_user(user_context)


# Global singleton
sentry_monitor = SentryMonitor()


class MonitoringMiddleware:
    """Middleware for monitoring audit operations"""
    
    @staticmethod
    def wrap_audit_operation(func):
        """Decorator to wrap audit operations with monitoring"""
        async def wrapper(*args, **kwargs):
            start_time = asyncio.get_event_loop().time()
            
            try:
                result = await func(*args, **kwargs)
                
                # Calculate metrics
                response_time_ms = (asyncio.get_event_loop().time() - start_time) * 1000
                
                # Record success
                from src.telemetry import telemetry
                user_id = kwargs.get("user_id") or (args[0] if args else None)
                contract = kwargs.get("contract_address", "unknown")
                cost = result.get("cost_usd", 0) if isinstance(result, dict) else 0
                risk = result.get("risk_score", 0) if isinstance(result, dict) else 0
                analysis_type = result.get("analysis_type", "unknown") if isinstance(result, dict) else "unknown"
                
                telemetry.record_audit(
                    user_id=user_id or 0,
                    contract_addr=contract,
                    analysis_type=analysis_type,
                    cost_usd=cost,
                    response_time_ms=response_time_ms,
                    risk_score=risk
                )
                
                return result
            
            except Exception as e:
                # Record error
                from src.telemetry import telemetry
                user_id = kwargs.get("user_id") or (args[0] if args else None)
                
                telemetry.record_error(
                    user_id=user_id,
                    error_type=type(e).__name__,
                    error_message=str(e)
                )
                
                # Report to Sentry
                sentry_monitor.capture_exception(e, context={
                    "user_id": user_id,
                    "operation": func.__name__
                })
                
                raise
        
        return wrapper


class PerformanceMonitor:
    """Monitors performance metrics and bottlenecks"""
    
    @staticmethod
    def measure_operation(operation_name: str):
        """Context manager to measure operation duration"""
        class MeasureContext:
            def __init__(self, op_name: str):
                self.op_name = op_name
                self.start_time = None
                self.duration_ms = 0
            
            async def __aenter__(self):
                self.start_time = asyncio.get_event_loop().time()
                return self
            
            async def __aexit__(self, exc_type, exc_val, exc_tb):
                self.duration_ms = (asyncio.get_event_loop().time() - self.start_time) * 1000
                
                if exc_type is None:
                    logger.debug(f"✅ {self.op_name} completed in {self.duration_ms:.0f}ms")
                    
                    # Record API call
                    from src.telemetry import telemetry
                    telemetry.record_api_call(
                        api_name=self.op_name.lower(),
                        success=True,
                        latency_ms=self.duration_ms
                    )
                else:
                    logger.warning(f"❌ {self.op_name} failed after {self.duration_ms:.0f}ms: {exc_type.__name__}")
                    
                    # Record API call failure
                    from src.telemetry import telemetry
                    telemetry.record_api_call(
                        api_name=self.op_name.lower(),
                        success=False,
                        latency_ms=self.duration_ms
                    )
                
                return False
        
        return MeasureContext(operation_name)


logger.info("🔍 Error tracking and monitoring initialized")
