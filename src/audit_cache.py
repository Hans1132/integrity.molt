"""
Audit History Caching and Retrieval
Tracks and caches recent audits for users and contracts
Enables fast history lookups and duplicate detection
"""
import logging
from typing import Optional, List, Dict, Any
from collections import OrderedDict
from datetime import datetime, timedelta
from dataclasses import dataclass, asdict

logger = logging.getLogger(__name__)


@dataclass
class AuditRecord:
    """Represents a cached audit record"""
    audit_id: str
    user_id: int
    contract_address: str
    timestamp: str
    risk_score: str
    findings_summary: str
    tokens_used: int
    cost_sol: float
    r2_url: Optional[str] = None
    nft_hash: Optional[str] = None


class AuditCache:
    """LRU cache for audit history with user and contract indexes"""
    
    def __init__(self, max_size: int = 1000, ttl_hours: int = 72):
        """
        Initialize audit cache
        
        Args:
            max_size: Maximum number of audits to cache in memory
            ttl_hours: Time-to-live for cached entries (hours)
        """
        self.max_size = max_size
        self.ttl_hours = ttl_hours
        
        # Main cache: audit_id -> AuditRecord
        self.audit_cache: OrderedDict[str, AuditRecord] = OrderedDict()
        
        # User index: user_id -> [audit_ids]
        self.user_index: Dict[int, List[str]] = {}
        
        # Contract index: contract_address -> [audit_ids]
        self.contract_index: Dict[str, List[str]] = {}
        
        # Metadata tracking
        self.cache_stats = {
            "total_audits_cached": 0,
            "hits": 0,
            "misses": 0,
            "evictions": 0
        }
        
        logger.info(f"✅ AuditCache initialized: max_size={max_size}, ttl={ttl_hours}h")
    
    def add_audit(self, audit_record: AuditRecord) -> bool:
        """
        Add audit to cache (with LRU eviction if needed)
        
        Args:
            audit_record: Audit record to cache
        
        Returns:
            True if added, False if error
        """
        try:
            audit_id = audit_record.audit_id
            user_id = audit_record.user_id
            contract = audit_record.contract_address
            
            # Check if cache is full
            if len(self.audit_cache) >= self.max_size:
                # Remove oldest entry (FIFO for LRU)
                removed_id, removed_record = self.audit_cache.popitem(last=False)
                old_user = removed_record.user_id
                old_contract = removed_record.contract_address
                
                # Update indexes
                if old_user in self.user_index:
                    self.user_index[old_user].remove(removed_id)
                if old_contract in self.contract_index:
                    self.contract_index[old_contract].remove(removed_id)
                
                self.cache_stats["evictions"] += 1
                logger.debug(f"Cache evicted: {removed_id} (LRU, size at max)")
            
            # Add to main cache
            self.audit_cache[audit_id] = audit_record
            
            # Update user index
            if user_id not in self.user_index:
                self.user_index[user_id] = []
            self.user_index[user_id].append(audit_id)
            
            # Update contract index
            if contract not in self.contract_index:
                self.contract_index[contract] = []
            self.contract_index[contract].append(audit_id)
            
            # Update stats
            self.cache_stats["total_audits_cached"] += 1
            
            logger.debug(
                f"✅ Audit cached: {audit_id} | "
                f"User: {user_id} | Contract: {contract[:8]}... | "
                f"Cache size: {len(self.audit_cache)}"
            )
            
            return True
        
        except Exception as e:
            logger.error(f"❌ Failed to add audit to cache: {e}")
            return False
    
    def get_user_history(
        self,
        user_id: int,
        limit: int = 10,
        include_expired: bool = False
    ) -> List[AuditRecord]:
        """
        Get audit history for a user
        
        Args:
            user_id: Telegram user ID
            limit: Maximum number of records to return
            include_expired: Include audits beyond TTL
        
        Returns:
            List of audit records (newest first)
        """
        try:
            if user_id not in self.user_index:
                logger.debug(f"No history found for user {user_id}")
                return []
            
            audit_ids = self.user_index[user_id]
            records = []
            
            # Iterate from newest to oldest (reverse order)
            for audit_id in reversed(audit_ids):
                if audit_id not in self.audit_cache:
                    continue
                
                record = self.audit_cache[audit_id]
                
                # Check TTL
                if not include_expired:
                    audit_time = datetime.fromisoformat(record.timestamp)
                    if datetime.utcnow() - audit_time > timedelta(hours=self.ttl_hours):
                        continue
                
                records.append(record)
                
                if len(records) >= limit:
                    break
            
            self.cache_stats["hits"] += 1
            logger.debug(f"✅ Retrieved {len(records)} audits for user {user_id}")
            
            return records
        
        except Exception as e:
            logger.error(f"❌ Failed to get user history: {e}")
            self.cache_stats["misses"] += 1
            return []
    
    def get_contract_history(
        self,
        contract_address: str,
        limit: int = 5
    ) -> List[AuditRecord]:
        """
        Get audit history for a contract (across all users)
        
        Args:
            contract_address: Solana contract address
            limit: Maximum number of records
        
        Returns:
            List of audit records (newest first)
        """
        try:
            if contract_address not in self.contract_index:
                logger.debug(f"No history for contract {contract_address[:8]}...")
                return []
            
            audit_ids = self.contract_index[contract_address]
            records = []
            
            # Get newest audits
            for audit_id in reversed(audit_ids):
                if audit_id in self.audit_cache:
                    records.append(self.audit_cache[audit_id])
                    
                    if len(records) >= limit:
                        break
            
            logger.debug(
                f"✅ Retrieved {len(records)} audits for contract {contract_address[:8]}..."
            )
            
            return records
        
        except Exception as e:
            logger.error(f"❌ Failed to get contract history: {e}")
            return []
    
    def is_recent_audit(
        self,
        user_id: int,
        contract_address: str,
        within_hours: int = 24
    ) -> Optional[AuditRecord]:
        """
        Check if user recently audited a contract (for deduplication)
        
        Args:
            user_id: User ID
            contract_address: Contract address
            within_hours: Lookback period
        
        Returns:
            Audit record if found, None otherwise
        """
        try:
            if user_id not in self.user_index:
                return None
            
            # Get user's recent audits
            cutoff = datetime.utcnow() - timedelta(hours=within_hours)
            
            for audit_id in reversed(self.user_index[user_id]):
                record = self.audit_cache.get(audit_id)
                if not record:
                    continue
                
                # Check timestamp and contract match
                audit_time = datetime.fromisoformat(record.timestamp)
                if audit_time > cutoff and record.contract_address == contract_address:
                    logger.debug(
                        f"✅ Found recent audit for user {user_id} → contract {contract_address[:8]}..."
                    )
                    return record
            
            return None
        
        except Exception as e:
            logger.error(f"❌ Failed to check recent audit: {e}")
            return None
    
    def get_cache_stats(self) -> Dict[str, Any]:
        """Get cache performance statistics"""
        try:
            total_requests = self.cache_stats["hits"] + self.cache_stats["misses"]
            hit_rate = (
                (self.cache_stats["hits"] / total_requests * 100)
                if total_requests > 0 else 0
            )
            
            return {
                "cache_size": len(self.audit_cache),
                "max_size": self.max_size,
                "users_tracked": len(self.user_index),
                "contracts_tracked": len(self.contract_index),
                "total_audits_cached": self.cache_stats["total_audits_cached"],
                "cache_hits": self.cache_stats["hits"],
                "cache_misses": self.cache_stats["misses"],
                "hit_rate": f"{hit_rate:.1f}%",
                "evictions": self.cache_stats["evictions"]
            }
        
        except Exception as e:
            logger.error(f"❌ Failed to get stats: {e}")
            return {}
    
    def clear_cache(self) -> bool:
        """Clear entire cache"""
        try:
            self.audit_cache.clear()
            self.user_index.clear()
            self.contract_index.clear()
            
            logger.info("✅ Cache cleared")
            return True
        
        except Exception as e:
            logger.error(f"❌ Failed to clear cache: {e}")
            return False
    
    def export_user_history(self, user_id: int) -> List[Dict[str, Any]]:
        """
        Export user history as JSON-serializable list
        
        Args:
            user_id: User ID
        
        Returns:
            List of audit dicts (newest first)
        """
        try:
            records = self.get_user_history(user_id, limit=100, include_expired=True)
            return [asdict(record) for record in records]
        
        except Exception as e:
            logger.error(f"❌ Failed to export history: {e}")
            return []


# Global audit cache instance
audit_cache = AuditCache(max_size=1000, ttl_hours=72)


def cache_audit_result(
    audit_id: str,
    user_id: int,
    contract_address: str,
    audit_result: dict
) -> bool:
    """
    Convenience function to cache audit result
    
    Args:
        audit_id: Unique audit identifier
        user_id: Telegram user ID
        contract_address: Contract being audited
        audit_result: Full audit result dict
    
    Returns:
        True if cached successfully
    """
    try:
        # Extract summary from findings
        findings = audit_result.get("findings", "No findings")
        summary = findings[:100] + "..." if len(findings) > 100 else findings
        
        record = AuditRecord(
            audit_id=audit_id,
            user_id=user_id,
            contract_address=contract_address,
            timestamp=datetime.utcnow().isoformat(),
            risk_score=audit_result.get("nft_anchor", {}).get("risk_score", "5"),
            findings_summary=summary,
            tokens_used=audit_result.get("tokens_used", 0),
            cost_sol=audit_result.get("cost_usd", 0) / 165,  # Rough SOL conversion
            r2_url=audit_result.get("r2_storage", {}).get("report_url"),
            nft_hash=audit_result.get("nft_anchor", {}).get("audit_hash")
        )
        
        return audit_cache.add_audit(record)
    
    except Exception as e:
        logger.error(f"❌ Failed to cache audit: {e}")
        return False


def get_user_audit_history(user_id: int, limit: int = 10) -> List[Dict[str, Any]]:
    """
    Convenience function to get user history
    
    Args:
        user_id: User ID
        limit: Max records
    
    Returns:
        List of audit dicts
    """
    records = audit_cache.get_user_history(user_id, limit)
    return [asdict(record) for record in records]


if __name__ == "__main__":
    # Test audit cache
    print("Testing Audit Cache...")
    
    # Create test records
    for i in range(5):
        record = AuditRecord(
            audit_id=f"audit_{i}",
            user_id=5940877089,
            contract_address=f"Contract_{i}",
            timestamp=datetime.utcnow().isoformat(),
            risk_score=str(i + 1),
            findings_summary=f"Test findings {i}",
            tokens_used=1000 + i * 100,
            cost_sol=0.005 + i * 0.001
        )
        audit_cache.add_audit(record)
    
    # Test retrieval
    print("\nUser History:")
    history = audit_cache.get_user_history(5940877089)
    for record in history:
        print(f"  - {record.audit_id}: {record.contract_address}")
    
    # Test stats
    print("\nCache Stats:")
    stats = audit_cache.get_cache_stats()
    for key, value in stats.items():
        print(f"  {key}: {value}")
    
    # Test recent audit detection
    print("\nRecent audit check:")
    recent = audit_cache.is_recent_audit(5940877089, "Contract_0", within_hours=24)
    print(f"  Found recent: {recent is not None}")
