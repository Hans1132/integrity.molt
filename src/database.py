"""
MongoDB Database Layer for integrity.molt
Handles persistent storage of audits, users, subscriptions, and transactions
Replaces in-memory caches in Phase 3+
"""
import logging
from typing import Dict, Any, List, Optional
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)


class MongoDBClient:
    """
    MongoDB client for integrity.molt data persistence
    
    Phase 3 Implementation:
    - Store audit history (user → audits)
    - Store subscription data (user → tier, expiry)
    - Store transaction records (payment → hash)
    - Store wallet sessions (user → wallet_address)
    - Query and retrieve user data efficiently
    
    Collections:
    1. audits - Security audit reports
    2. users - User profiles and preferences
    3. subscriptions - Subscription records
    4. transactions - Payment and NFT transactions
    5. wallets - Phantom wallet sessions
    6. quota_usage - Rate limit tracking
    """
    
    # MongoDB connection (will use environment variable in Phase 3)
    # MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017/integrity_molt")
    
    def __init__(self, connection_string: Optional[str] = None):
        """
        Initialize MongoDB client
        
        Args:
            connection_string: MongoDB connection URI (optional)
        """
        self.connected = False
        self.db = None
        self.client = None
        
        # Phase 3: Actual MongoDB connection
        # from pymongo import MongoClient
        # self.client = MongoClient(connection_string or os.getenv("MONGODB_URI"))
        # self.db = self.client["integrity_molt"]
        
        # For Phase 2/3 testing, use in-memory mock
        self.collections = {
            "audits": [],
            "users": [],
            "subscriptions": [],
            "transactions": [],
            "wallets": [],
            "quota_usage": []
        }
        
        self.connected = True
        logger.info("✅ MongoDB Client initialized (mock mode - Phase 3 will use real DB)")
    
    # ============= AUDIT OPERATIONS =============
    
    def insert_audit(self, audit_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Store audit report in database
        
        Args:
            audit_data: Audit result dict
        
        Returns:
            Inserted document with _id
        """
        try:
            audit_doc = {
                "_id": audit_data.get("audit_id"),
                "user_id": audit_data.get("user_id", 0),
                "contract_address": audit_data.get("contract_address"),
                "status": audit_data.get("status", "success"),
                "findings": audit_data.get("findings", ""),
                "risk_score": audit_data.get("nft_anchor", {}).get("risk_score", 5),
                "tokens_used": audit_data.get("tokens_used", 0),
                "cost_usd": audit_data.get("cost_usd", 0.0),
                "r2_url": audit_data.get("r2_storage", {}).get("report_url"),
                "nft_mint": audit_data.get("nft_anchor", {}).get("audit_hash"),
                "created_at": datetime.utcnow().isoformat(),
                "patterns": audit_data.get("pattern_findings", []),
                "payment_id": audit_data.get("payment", {}).get("payment_id")
            }
            
            self.collections["audits"].append(audit_doc)
            
            logger.info(
                f"✅ Audit stored: {audit_doc['_id']} | "
                f"User: {audit_doc['user_id']} | Risk: {audit_doc['risk_score']}"
            )
            
            return {"status": "inserted", "audit_id": audit_doc["_id"]}
        
        except Exception as e:
            logger.error(f"❌ Audit insertion failed: {e}")
            return {"status": "error", "error": str(e)}
    
    def get_user_audits(
        self,
        user_id: int,
        limit: int = 50,
        skip: int = 0
    ) -> List[Dict[str, Any]]:
        """
        Retrieve audit history for user
        
        Args:
            user_id: Telegram user ID
            limit: Max results (default 50)
            skip: Skip first N results (for pagination)
        
        Returns:
            List of audit documents
        """
        try:
            user_audits = [
                doc for doc in self.collections["audits"]
                if doc.get("user_id") == user_id
            ]
            
            # Sort by created_at descending (newest first)
            user_audits.sort(
                key=lambda x: x.get("created_at", ""),
                reverse=True
            )
            
            # Apply pagination
            result = user_audits[skip:skip+limit]
            
            logger.info(f"📖 Retrieved {len(result)} audits for user {user_id}")
            
            return result
        
        except Exception as e:
            logger.error(f"❌ Audit retrieval failed: {e}")
            return []
    
    def get_contract_audits(
        self,
        contract_address: str,
        limit: int = 10
    ) -> List[Dict[str, Any]]:
        """
        Retrieve all audits for a specific contract
        
        Args:
            contract_address: Contract address
            limit: Max results
        
        Returns:
            List of audit documents
        """
        try:
            contract_audits = [
                doc for doc in self.collections["audits"]
                if doc.get("contract_address") == contract_address
            ]
            
            # Sort by created_at descending
            contract_audits.sort(
                key=lambda x: x.get("created_at", ""),
                reverse=True
            )
            
            result = contract_audits[:limit]
            
            logger.info(f"📊 Retrieved {len(result)} audits for contract {contract_address[:16]}...")
            
            return result
        
        except Exception as e:
            logger.error(f"❌ Contract audit retrieval failed: {e}")
            return []
    
    # ============= USER OPERATIONS =============
    
    def insert_user(self, user_id: int, user_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Store user profile
        
        Args:
            user_id: Telegram user ID
            user_data: User profile data
        
        Returns:
            Insertion result
        """
        try:
            user_doc = {
                "_id": user_id,
                "telegram_id": user_id,
                "username": user_data.get("username"),
                "tier": user_data.get("tier", "free"),
                "created_at": datetime.utcnow().isoformat(),
                "audits_total": 0,
                "spend_total_sol": 0.0,
                "verified": user_data.get("verified", False),
                "banned": False
            }
            
            # Check if user already exists
            existing = next(
                (u for u in self.collections["users"] if u["_id"] == user_id),
                None
            )
            
            if existing:
                return {"status": "exists", "user_id": user_id}
            
            self.collections["users"].append(user_doc)
            
            logger.info(f"✅ User created: {user_id} | Tier: {user_doc['tier']}")
            
            return {"status": "inserted", "user_id": user_id}
        
        except Exception as e:
            logger.error(f"❌ User insertion failed: {e}")
            return {"status": "error", "error": str(e)}
    
    def get_user(self, user_id: int) -> Optional[Dict[str, Any]]:
        """
        Retrieve user profile
        
        Args:
            user_id: Telegram user ID
        
        Returns:
            User document or None
        """
        try:
            user = next(
                (u for u in self.collections["users"] if u["_id"] == user_id),
                None
            )
            
            if user:
                logger.debug(f"📖 User retrieved: {user_id}")
            else:
                # Create on first access
                self.insert_user(user_id, {"tier": "free"})
                user = next(
                    (u for u in self.collections["users"] if u["_id"] == user_id),
                    None
                )
            
            return user
        
        except Exception as e:
            logger.error(f"❌ User retrieval failed: {e}")
            return None
    
    # ============= SUBSCRIPTION OPERATIONS =============
    
    def set_subscription(
        self,
        user_id: int,
        tier: str,
        duration_days: int = 30,
        transaction_hash: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Set or update user subscription
        
        Args:
            user_id: Telegram user ID
            tier: Subscription tier
            duration_days: Duration in days
            transaction_hash: Payment transaction hash
        
        Returns:
            Subscription record
        """
        try:
            expiry = (datetime.utcnow() + timedelta(days=duration_days)).isoformat()
            
            subscription = {
                "_id": f"sub_{user_id}_{int(datetime.utcnow().timestamp())}",
                "user_id": user_id,
                "tier": tier,
                "started_at": datetime.utcnow().isoformat(),
                "expires_at": expiry,
                "duration_days": duration_days,
                "transaction_hash": transaction_hash,
                "status": "active"
            }
            
            self.collections["subscriptions"].append(subscription)
            
            # Update user tier
            user = self.get_user(user_id)
            if user:
                user["tier"] = tier
            
            logger.info(
                f"✅ Subscription set: User {user_id} | Tier: {tier} | "
                f"Expires: {expiry}"
            )
            
            return subscription
        
        except Exception as e:
            logger.error(f"❌ Subscription creation failed: {e}")
            return {"status": "error", "error": str(e)}
    
    def get_active_subscription(self, user_id: int) -> Optional[Dict[str, Any]]:
        """
        Get active subscription for user
        
        Args:
            user_id: Telegram user ID
        
        Returns:
            Active subscription or None
        """
        try:
            subscriptions = [
                s for s in self.collections["subscriptions"]
                if s.get("user_id") == user_id and s.get("status") == "active"
            ]
            
            # Check expiry
            active_subs = [
                s for s in subscriptions
                if datetime.fromisoformat(s.get("expires_at", "")) > datetime.utcnow()
            ]
            
            if active_subs:
                return active_subs[-1]  # Most recent
            
            return None
        
        except Exception as e:
            logger.error(f"❌ Subscription retrieval failed: {e}")
            return None
    
    # ============= TRANSACTION OPERATIONS =============
    
    def insert_transaction(self, transaction_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Store payment or NFT transaction record
        
        Args:
            transaction_data: Transaction details
        
        Returns:
            Insertion result
        """
        try:
            tx_doc = {
                "_id": transaction_data.get("transaction_hash", f"tx_{int(datetime.utcnow().timestamp())}"),
                "user_id": transaction_data.get("user_id"),
                "transaction_type": transaction_data.get("transaction_type"),
                "amount_sol": transaction_data.get("amount_sol", 0.0),
                "status": transaction_data.get("status", "pending"),
                "created_at": datetime.utcnow().isoformat(),
                "confirmed_at": transaction_data.get("confirmed_at"),
                "audit_id": transaction_data.get("audit_id"),
                "payment_id": transaction_data.get("payment_id"),
                "solscan_link": transaction_data.get("solscan_link")
            }
            
            self.collections["transactions"].append(tx_doc)
            
            logger.info(
                f"✅ Transaction stored: {tx_doc['_id'][:16]}... | "
                f"Type: {tx_doc['transaction_type']} | "
                f"Amount: {tx_doc['amount_sol']} SOL"
            )
            
            return {"status": "inserted", "transaction_id": tx_doc["_id"]}
        
        except Exception as e:
            logger.error(f"❌ Transaction insertion failed: {e}")
            return {"status": "error", "error": str(e)}
    
    # ============= WALLET OPERATIONS =============
    
    def insert_wallet_session(
        self,
        user_id: int,
        wallet_address: str,
        session_token: str
    ) -> Dict[str, Any]:
        """
        Store Phantom wallet session
        
        Args:
            user_id: Telegram user ID
            wallet_address: Solana wallet address
            session_token: Session token
        
        Returns:
            Session record
        """
        try:
            wallet_doc = {
                "_id": f"wallet_{user_id}",
                "user_id": user_id,
                "wallet_address": wallet_address,
                "session_token": session_token,
                "connected_at": datetime.utcnow().isoformat(),
                "confirmed": True
            }
            
            self.collections["wallets"].append(wallet_doc)
            
            logger.info(
                f"✅ Wallet session stored: User {user_id} | "
                f"Address: {wallet_address[:16]}..."
            )
            
            return wallet_doc
        
        except Exception as e:
            logger.error(f"❌ Wallet session insertion failed: {e}")
            return {"status": "error", "error": str(e)}
    
    # ============= QUOTA OPERATIONS =============
    
    def get_quota_stats(self, user_id: int) -> Dict[str, Any]:
        """
        Get quota statistics for user this month
        
        Args:
            user_id: Telegram user ID
        
        Returns:
            Quota statistics
        """
        try:
            now = datetime.utcnow()
            month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
            
            # Count audits this month
            monthly = [
                a for a in self.collections["audits"]
                if a.get("user_id") == user_id
                and datetime.fromisoformat(a.get("created_at", "")) >= month_start
            ]
            
            monthly_cost = sum(a.get("cost_usd", 0.0) for a in monthly)
            
            return {
                "audits_this_month": len(monthly),
                "cost_this_month_usd": monthly_cost,
                "user_id": user_id
            }
        
        except Exception as e:
            logger.error(f"❌ Quota stats retrieval failed: {e}")
            return {}
    
    def health_check(self) -> Dict[str, Any]:
        """Check database connection health"""
        try:
            return {
                "status": "healthy" if self.connected else "disconnected",
                "connected": self.connected,
                "collections": len(self.collections),
                "audits_count": len(self.collections["audits"]),
                "users_count": len(self.collections["users"]),
                "subscriptions_count": len(self.collections["subscriptions"])
            }
        except Exception as e:
            logger.error(f"❌ Health check failed: {e}")
            return {"status": "error", "error": str(e)}


# Global instance
db_client = MongoDBClient()


if __name__ == "__main__":
    # Test MongoDB client
    print("Testing MongoDB Client...")
    print("=" * 50)
    
    # Insert user
    db_client.insert_user(12345, {"tier": "free", "username": "test_user"})
    
    # Insert audit
    db_client.insert_audit({
        "audit_id": "audit_001",
        "user_id": 12345,
        "contract_address": "EvXNCtaoVuC1NQLQswAnqsbQKPgVTdjrrLKa8MpMJiLf",
        "status": "success",
        "findings": "Test findings",
        "risk_score": 7,
        "cost_usd": 0.03
    })
    
    # Retrieve user audits
    audits = db_client.get_user_audits(12345)
    print(f"\n1. User Audits: {len(audits)} found")
    
    # Set subscription
    db_client.set_subscription(12345, "subscriber", 30)
    
    # Health check
    health = db_client.health_check()
    print(f"\n2. Database Health:")
    print(f"  Status: {health['status']}")
    print(f"  Audits: {health['audits_count']}")
    print(f"  Users: {health['users_count']}")
    print(f"  Subscriptions: {health['subscriptions_count']}")
    
    print("\n✅ MongoDB client test complete!")
