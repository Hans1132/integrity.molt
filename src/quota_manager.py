"""
Rate Limiting and Quota Management
Enforces audit limits per user, subscription tier, and cost constraints
"""
import logging
from typing import Optional, Dict, Any
from datetime import datetime, timedelta
from collections import defaultdict

logger = logging.getLogger(__name__)


class QuotaManager:
    """Manages rate limits and quotas for users and global systems"""
    
    # Quota tiers (in-memory, Phase 2)
    TIERS = {
        "free": {
            "audits_per_hour": 2,
            "audits_per_day": 5,
            "audits_per_month": 20,
            "monthly_budget_sol": 0.1,  # ~$6
            "description": "Free tier: limited audits"
        },
        "subscriber": {
            "audits_per_hour": 10,
            "audits_per_day": 50,
            "audits_per_month": 999,  # Effectively unlimited
            "monthly_budget_sol": 10.0,  # ~$600 budget
            "description": "Subscriber tier: 0.1 SOL/month"
        },
        "premium": {
            "audits_per_hour": 20,
            "audits_per_day": 100,
            "audits_per_month": 9999,  # Effectively unlimited
            "monthly_budget_sol": 100.0,  # ~$6000 budget
            "description": "Premium tier: custom plans"
        }
    }
    
    # Global rate limit
    GLOBAL_LIMIT = {
        "audits_per_minute": 100,  # Prevent DoS
        "audits_per_hour": 10000
    }
    
    def __init__(self):
        """Initialize quota manager"""
        # User tracking
        self.user_tiers: Dict[int, str] = defaultdict(lambda: "free")
        
        # Audit counts: {user_id: {window: [timestamps]}}
        self.audit_timestamps: Dict[int, list] = defaultdict(list)
        
        # User spending: {user_id: {month: total_sol}}
        self.user_spending: Dict[int, Dict[str, float]] = defaultdict(lambda: defaultdict(float))
        
        # Global tracking
        self.global_audit_timestamps: list = []
        
        logger.info("✅ QuotaManager initialized")
    
    def set_user_tier(self, user_id: int, tier: str) -> bool:
        """
        Set user subscription tier
        
        Args:
            user_id: User ID
            tier: "free", "subscriber", or "premium"
        
        Returns:
            True if set successfully
        """
        if tier not in self.TIERS:
            logger.error(f"❌ Invalid tier: {tier}")
            return False
        
        self.user_tiers[user_id] = tier
        logger.info(f"✅ User {user_id} tier set to: {tier}")
        return True
    
    def _get_month_key(self, date: Optional[datetime] = None) -> str:
        """Get month key for spending tracking (YYYY-MM)"""
        if date is None:
            date = datetime.utcnow()
        return date.strftime("%Y-%m")
    
    def _is_within_window(self, timestamp: datetime, window_minutes: int) -> bool:
        """Check if timestamp is within time window"""
        return (datetime.utcnow() - timestamp).total_seconds() < (window_minutes * 60)
    
    def can_audit(
        self,
        user_id: int,
        cost_estimate_sol: float = 0.0
    ) -> Dict[str, Any]:
        """
        Check if user can perform an audit
        
        Args:
            user_id: User ID
            cost_estimate_sol: Estimated cost of audit
        
        Returns:
            dict with:
            - allowed: True/False
            - reason: Why blocked (if not allowed)
            - remaining: Quotas available
            - details: Current usage
        """
        try:
            tier = self.user_tiers[user_id]
            quota = self.TIERS[tier]
            
            now = datetime.utcnow()
            month_key = self._get_month_key()
            
            # Clean old timestamps (older than 24 hours)
            cutoff = now - timedelta(hours=24)
            self.audit_timestamps[user_id] = [
                ts for ts in self.audit_timestamps[user_id]
                if ts > cutoff
            ]
            
            # Count audits in different windows
            audits_this_hour = sum(
                1 for ts in self.audit_timestamps[user_id]
                if self._is_within_window(ts, 60)
            )
            
            audits_this_day = sum(
                1 for ts in self.audit_timestamps[user_id]
                if self._is_within_window(ts, 1440)
            )
            
            audits_this_month = len(self.audit_timestamps[user_id])  # Already filtered
            
            # Check hourly limit
            if audits_this_hour >= quota["audits_per_hour"]:
                return {
                    "allowed": False,
                    "reason": f"Hourly limit reached ({quota['audits_per_hour']} audits/hour)",
                    "remaining": {
                        "hourly": 0,
                        "daily": max(0, quota["audits_per_day"] - audits_this_day),
                        "monthly": max(0, quota["audits_per_month"] - audits_this_month)
                    },
                    "tier": tier
                }
            
            # Check daily limit
            if audits_this_day >= quota["audits_per_day"]:
                return {
                    "allowed": False,
                    "reason": f"Daily limit reached ({quota['audits_per_day']} audits/day)",
                    "remaining": {
                        "hourly": max(0, quota["audits_per_hour"] - audits_this_hour),
                        "daily": 0,
                        "monthly": max(0, quota["audits_per_month"] - audits_this_month)
                    },
                    "tier": tier
                }
            
            # Check monthly limit
            if audits_this_month >= quota["audits_per_month"]:
                return {
                    "allowed": False,
                    "reason": f"Monthly limit reached ({quota['audits_per_month']} audits/month)",
                    "remaining": {
                        "hourly": max(0, quota["audits_per_hour"] - audits_this_hour),
                        "daily": max(0, quota["audits_per_day"] - audits_this_day),
                        "monthly": 0
                    },
                    "tier": tier
                }
            
            # Check budget limit
            spent_this_month = self.user_spending[user_id].get(month_key, 0.0)
            budget = quota["monthly_budget_sol"]
            
            if spent_this_month + cost_estimate_sol > budget:
                remaining_budget = max(0, budget - spent_this_month)
                return {
                    "allowed": False,
                    "reason": f"Monthly budget limit reached (${budget * 165:.2f}; spent: ${spent_this_month * 165:.2f})",
                    "remaining": {
                        "hourly": max(0, quota["audits_per_hour"] - audits_this_hour),
                        "daily": max(0, quota["audits_per_day"] - audits_this_day),
                        "monthly": max(0, quota["audits_per_month"] - audits_this_month),
                        "budget_sol": remaining_budget
                    },
                    "tier": tier
                }
            
            # Check global rate limit
            now_str = now.strftime("%Y-%m-%d %H:%M")
            minute_ago = now - timedelta(minutes=1)
            global_last_minute = sum(
                1 for ts_str in self.global_audit_timestamps
                if ts_str > minute_ago.isoformat()
            )
            
            if global_last_minute >= self.GLOBAL_LIMIT["audits_per_minute"]:
                return {
                    "allowed": False,
                    "reason": "System rate limit reached, try again in a moment",
                    "remaining": {
                        "hourly": max(0, quota["audits_per_hour"] - audits_this_hour),
                        "daily": max(0, quota["audits_per_day"] - audits_this_day),
                        "monthly": max(0, quota["audits_per_month"] - audits_this_month)
                    },
                    "tier": tier
                }
            
            # Allowed!
            return {
                "allowed": True,
                "reason": "Quota OK",
                "remaining": {
                    "hourly": max(0, quota["audits_per_hour"] - audits_this_hour - 1),
                    "daily": max(0, quota["audits_per_day"] - audits_this_day - 1),
                    "monthly": max(0, quota["audits_per_month"] - audits_this_month - 1),
                    "budget_sol": max(0, budget - spent_this_month - cost_estimate_sol)
                },
                "tier": tier
            }
        
        except Exception as e:
            logger.error(f"❌ Failed to check quota: {e}")
            return {
                "allowed": False,
                "reason": f"Quota check error: {str(e)}",
                "tier": "free"
            }
    
    def record_audit(
        self,
        user_id: int,
        cost_sol: float = 0.0
    ) -> bool:
        """
        Record an audit for quota tracking
        
        Args:
            user_id: User ID
            cost_sol: Audit cost in SOL
        
        Returns:
            True if recorded
        """
        try:
            now = datetime.utcnow()
            month_key = self._get_month_key()
            
            # Record user audit timestamp
            self.audit_timestamps[user_id].append(now)
            
            # Record spending
            self.user_spending[user_id][month_key] += cost_sol
            
            # Record global timestamp
            self.global_audit_timestamps.append(now.isoformat())
            
            # Clean old global timestamps (older than 1 hour)
            cutoff = now - timedelta(hours=1)
            self.global_audit_timestamps = [
                ts for ts in self.global_audit_timestamps
                if datetime.fromisoformat(ts) > cutoff
            ]
            
            logger.debug(
                f"✅ Audit recorded: User {user_id} | "
                f"Cost: {cost_sol} SOL | Total this month: {self.user_spending[user_id][month_key]:.6f} SOL"
            )
            
            return True
        
        except Exception as e:
            logger.error(f"❌ Failed to record audit: {e}")
            return False
    
    def get_user_quota_info(self, user_id: int) -> Dict[str, Any]:
        """Get detailed quota information for a user"""
        try:
            tier = self.user_tiers[user_id]
            quota = self.TIERS[tier]
            month_key = self._get_month_key()
            
            # Count audits
            now = datetime.utcnow()
            audits_this_hour = sum(
                1 for ts in self.audit_timestamps[user_id]
                if self._is_within_window(ts, 60)
            )
            audits_this_day = sum(
                1 for ts in self.audit_timestamps[user_id]
                if self._is_within_window(ts, 1440)
            )
            audits_this_month = len(self.audit_timestamps[user_id])
            
            spent_this_month = self.user_spending[user_id].get(month_key, 0.0)
            
            return {
                "user_id": user_id,
                "tier": tier,
                "description": quota["description"],
                "current_month": month_key,
                "usage": {
                    "audits_this_hour": f"{audits_this_hour}/{quota['audits_per_hour']}",
                    "audits_this_day": f"{audits_this_day}/{quota['audits_per_day']}",
                    "audits_this_month": f"{audits_this_month}/{quota['audits_per_month']}",
                    "spending_this_month_sol": f"{spent_this_month:.6f}/{quota['monthly_budget_sol']:.6f}",
                    "spending_this_month_usd": f"${spent_this_month * 165:.2f}/${quota['monthly_budget_sol'] * 165:.2f}"
                },
                "limits": quota
            }
        
        except Exception as e:
            logger.error(f"❌ Failed to get quota info: {e}")
            return {}
    
    def reset_user_quotas(self, user_id: int) -> bool:
        """Reset user monthly quotas (call on first day of month)"""
        try:
            self.audit_timestamps[user_id] = []
            logger.info(f"✅ Monthly quotas reset for user {user_id}")
            return True
        except Exception as e:
            logger.error(f"❌ Failed to reset quotas: {e}")
            return False


# Global quota manager instance
quota_manager = QuotaManager()


def can_perform_audit(user_id: int, cost_estimate_sol: float = 0.0) -> Dict[str, Any]:
    """Convenience function to check if user can audit"""
    return quota_manager.can_audit(user_id, cost_estimate_sol)


def record_completed_audit(user_id: int, cost_sol: float = 0.0) -> bool:
    """Convenience function to record completed audit"""
    return quota_manager.record_audit(user_id, cost_sol)


if __name__ == "__main__":
    # Test quota manager
    print("Testing Quota Manager...")
    
    # Set tier
    quota_manager.set_user_tier(5940877089, "free")
    
    # Test quota check
    print("\n1. Initial check (should allow):")
    result = quota_manager.can_audit(5940877089, 0.005)
    print(f"  Allowed: {result['allowed']}")
    print(f"  Remaining: {result['remaining']}")
    
    # Record audit
    quota_manager.record_audit(5940877089, 0.005)
    print(f"\n2. After 1 audit:")
    info = quota_manager.get_user_quota_info(5940877089)
    print(f"  Usage: {info['usage']}")
    
    # Test with subscriber
    print(f"\n3. Switch to subscriber tier:")
    quota_manager.set_user_tier(5940877089, "subscriber")
    result = quota_manager.can_audit(5940877089, 0.005)
    print(f"  Allowed: {result['allowed']}")
    print(f"  Remaining: {result['remaining']}")
