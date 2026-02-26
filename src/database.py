"""
MongoDB Database Layer for integrity.molt (Phase 3c)
Handles persistent storage of audits, users, subscriptions, and transactions
Supports both real MongoDB and in-memory mock mode
"""
import logging
import os
from typing import Dict, Any, List, Optional
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)

# Try to import pymongo for real MongoDB support
try:
    from pymongo import MongoClient
    from pymongo.errors import ConnectionFailure, ServerSelectionTimeoutError
    PYMONGO_AVAILABLE = True
except ImportError:
    PYMONGO_AVAILABLE = False
    logger.warning("⚠️  pymongo not installed - database will use mock mode only")


class MongoDBClient:
    """
    MongoDB client for integrity.molt data persistence (Phase 3c)
    
    Features:
    - Real MongoDB support (production)
    - Mock in-memory storage (development/testing)
    - Automatic fallback if MongoDB unavailable
    
    Collections:
    1. audits - Security audit reports
    2. users - User profiles and preferences
    3. subscriptions - Subscription records
    4. transactions - Payment and NFT transactions
    5. wallets - Phantom wallet sessions
    6. quota_usage - Rate limit tracking
    """
    
    def __init__(self, connection_string: Optional[str] = None, force_mock: bool = False):
        """
        Initialize MongoDB client
        
        Args:
            connection_string: MongoDB connection URI (optional)
            force_mock: Force mock mode even if MongoDB available
        """
        self.connected = False
        self.db = None
        self.client = None
        self.use_mock = force_mock
        
        # Get connection string from parameter, env, or default
        mongo_uri = connection_string or os.getenv(
            "MONGODB_URI",
            "mongodb://localhost:27017/integrity_molt"
        )
        
        # Get database mode from env (mock or real)
        db_mode = os.getenv("DATABASE_MODE", "mock" if not PYMONGO_AVAILABLE else "real")
        
        # Try real MongoDB if available and not forced to mock
        if db_mode == "real" and PYMONGO_AVAILABLE and not force_mock:
            self._init_real_mongodb(mongo_uri)
        else:
            self._init_mock_mongodb()
    
    def _init_real_mongodb(self, connection_string: str):
        """Initialize real MongoDB connection"""
        try:
            logger.info(f"🔄 Connecting to MongoDB: {connection_string[:50]}...")
            
            self.client = MongoClient(
                connection_string,
                serverSelectionTimeoutMS=5000,
                socketTimeoutMS=5000,
                connectTimeoutMS=5000
            )
            
            # Test connection
            self.client.admin.command("ping")
            
            self.db = self.client["integrity_molt"]
            self.connected = True
            self.use_mock = False
            
            # Create indexes for performance
            self._create_indexes()
            
            logger.info("✅ Real MongoDB connected successfully!")
            
        except (ConnectionFailure, ServerSelectionTimeoutError) as e:
            logger.warning(f"⚠️  MongoDB connection failed: {e}")
            logger.warning("📦 Falling back to mock mode...")
            self._init_mock_mongodb()
        except Exception as e:
            logger.error(f"❌ MongoDB initialization error: {e}")
            self._init_mock_mongodb()
    
    def _init_mock_mongodb(self):
        """Initialize in-memory mock database (fallback/testing)"""
        self.use_mock = True
        self.connected = True
        
        # In-memory collections for mock mode
        self.collections = {
            "audits": [],
            "users": [],
            "subscriptions": [],
            "transactions": [],
            "wallets": [],
            "quota_usage": []
        }
        
        logger.info("✅ Mock MongoDB initialized (development/testing mode)")
    
    def _create_indexes(self):
        """Create database indexes for real MongoDB"""
        if self.use_mock or not self.db:
            return
        
        try:
            # Audit indexes
            self.db["audits"].create_index("user_id")
            self.db["audits"].create_index("contract_address")
            self.db["audits"].create_index("created_at")
            
            # User indexes
            self.db["users"].create_index("telegram_id", unique=True)
            
            # Subscription indexes
            self.db["subscriptions"].create_index("user_id")
            self.db["subscriptions"].create_index("expires_at")
            
            # Transaction indexes
            self.db["transactions"].create_index("user_id")
            self.db["transactions"].create_index("created_at")
            
            # Wallet indexes
            self.db["wallets"].create_index("user_id", unique=True)
            
            logger.debug("✅ Database indexes created")
        except Exception as e:
            logger.warning(f"⚠️  Index creation warning: {e}")
    
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
                "analysis_type": audit_data.get("analysis_type", "gpt4"),  # gpt4 or pattern-based
                "r2_url": audit_data.get("r2_storage", {}).get("report_url"),
                "nft_mint": audit_data.get("nft_anchor", {}).get("audit_hash"),
                "created_at": datetime.utcnow().isoformat(),
                "patterns": audit_data.get("pattern_findings", []),
                "payment_id": audit_data.get("payment", {}).get("payment_id")
            }
            
            if self.use_mock:
                self.collections["audits"].append(audit_doc)
            else:
                self.db["audits"].insert_one(audit_doc)
            
            logger.info(
                f"✅ Audit stored ({self._db_mode()}): {audit_doc['_id'][:16]}... | "
                f"User: {audit_doc['user_id']} | Type: {audit_doc['analysis_type']}"
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
            if self.use_mock:
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
            else:
                result = list(
                    self.db["audits"]
                    .find({"user_id": user_id})
                    .sort("created_at", -1)
                    .skip(skip)
                    .limit(limit)
                )
            
            logger.info(f"📖 Retrieved {len(result)} audits for user {user_id} ({self._db_mode()})")
            
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
            if self.use_mock:
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
            else:
                result = list(
                    self.db["audits"]
                    .find({"contract_address": contract_address})
                    .sort("created_at", -1)
                    .limit(limit)
                )
            
            logger.info(f"📊 Retrieved {len(result)} audits for contract ({self._db_mode()})")
            
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
            
            if self.use_mock:
                # Check if user already exists
                existing = next(
                    (u for u in self.collections["users"] if u["_id"] == user_id),
                    None
                )
                
                if existing:
                    return {"status": "exists", "user_id": user_id}
                
                self.collections["users"].append(user_doc)
            else:
                # Try to insert, handle duplicate key
                try:
                    self.db["users"].insert_one(user_doc)
                except Exception as e:
                    if "duplicate key" in str(e):
                        return {"status": "exists", "user_id": user_id}
                    raise
            
            logger.info(f"✅ User created ({self._db_mode()}): {user_id} | Tier: {user_doc['tier']}")
            
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
            if self.use_mock:
                user = next(
                    (u for u in self.collections["users"] if u["_id"] == user_id),
                    None
                )
            else:
                user = self.db["users"].find_one({"_id": user_id})
            
            if user:
                logger.debug(f"📖 User retrieved ({self._db_mode()}): {user_id}")
            else:
                # Create on first access
                self.insert_user(user_id, {"tier": "free"})
                if self.use_mock:
                    user = next(
                        (u for u in self.collections["users"] if u["_id"] == user_id),
                        None
                    )
                else:
                    user = self.db["users"].find_one({"_id": user_id})
            
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
            
            if self.use_mock:
                self.collections["subscriptions"].append(subscription)
            else:
                self.db["subscriptions"].insert_one(subscription)
            
            # Update user tier
            user = self.get_user(user_id)
            if user:
                if self.use_mock:
                    user["tier"] = tier
                else:
                    self.db["users"].update_one(
                        {"_id": user_id},
                        {"$set": {"tier": tier}}
                    )
            
            logger.info(
                f"✅ Subscription set ({self._db_mode()}): User {user_id} | Tier: {tier} | "
                f"Expires: {expiry[:10]}"
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
            if self.use_mock:
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
            else:
                result = self.db["subscriptions"].find_one(
                    {
                        "user_id": user_id,
                        "status": "active",
                        "expires_at": {"$gt": datetime.utcnow().isoformat()}
                    },
                    sort=[("expires_at", -1)]
                )
                if result:
                    return result
            
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
            
            if self.use_mock:
                self.collections["transactions"].append(tx_doc)
            else:
                self.db["transactions"].insert_one(tx_doc)
            
            logger.info(
                f"✅ Transaction stored ({self._db_mode()}): {tx_doc['_id'][:16]}... | "
                f"Type: {tx_doc['transaction_type']} | {tx_doc['amount_sol']} SOL"
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
            
            if self.use_mock:
                self.collections["wallets"].append(wallet_doc)
            else:
                # Upsert to replace if exists
                self.db["wallets"].update_one(
                    {"_id": f"wallet_{user_id}"},
                    {"$set": wallet_doc},
                    upsert=True
                )
            
            logger.info(
                f"✅ Wallet session stored ({self._db_mode()}): User {user_id}"
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
            month_start_iso = month_start.isoformat()
            
            if self.use_mock:
                # Count audits this month
                monthly = [
                    a for a in self.collections["audits"]
                    if a.get("user_id") == user_id
                    and datetime.fromisoformat(a.get("created_at", "")) >= month_start
                ]
            else:
                monthly = list(
                    self.db["audits"].find({
                        "user_id": user_id,
                        "created_at": {"$gte": month_start_iso}
                    })
                )
            
            monthly_cost = sum(a.get("cost_usd", 0.0) for a in monthly)
            
            return {
                "audits_this_month": len(monthly),
                "cost_this_month_usd": monthly_cost,
                "user_id": user_id
            }
        
        except Exception as e:
            logger.error(f"❌ Quota stats retrieval failed: {e}")
            return {}
    
    def _db_mode(self) -> str:
        """Return current database mode for logging"""
        return "mock" if self.use_mock else "mongodb"
    
    def health_check(self) -> Dict[str, Any]:
        """Check database connection health"""
        try:
            if self.use_mock:
                return {
                    "status": "healthy",
                    "connected": self.connected,
                    "mode": "mock",
                    "collections": len(self.collections),
                    "audits_count": len(self.collections["audits"]),
                    "users_count": len(self.collections["users"]),
                    "subscriptions_count": len(self.collections["subscriptions"]),
                    "transactions_count": len(self.collections["transactions"])
                }
            else:
                # Try to ping MongoDB
                self.client.admin.command("ping")
                
                return {
                    "status": "healthy",
                    "connected": self.connected,
                    "mode": "mongodb",
                    "audits_count": self.db["audits"].count_documents({}),
                    "users_count": self.db["users"].count_documents({}),
                    "subscriptions_count": self.db["subscriptions"].count_documents({}),
                    "transactions_count": self.db["transactions"].count_documents({})
                }
        except Exception as e:
            logger.error(f"❌ Health check failed: {e}")
            return {
                "status": "error",
                "connected": False,
                "error": str(e),
                "mode": self._db_mode()
            }


# Global instance
db_client = MongoDBClient()


if __name__ == "__main__":
    # Test MongoDB client
    print("Testing MongoDB Client (Phase 3c)...")
    print("=" * 60)
    print(f"Mode: {db_client._db_mode().upper()}")
    print("=" * 60)
    
    # Insert user
    db_client.insert_user(12345, {"tier": "free", "username": "test_user"})
    
    # Insert audit (pattern-based)
    db_client.insert_audit({
        "audit_id": "audit_pattern_001",
        "user_id": 12345,
        "contract_address": "EvXNCtaoVuC1NQLQswAnqsbQKPgVTdjrrLKa8MpMJiLf",
        "status": "success",
        "findings": "Test findings",
        "risk_score": 7,
        "cost_usd": 0.0,
        "analysis_type": "pattern-based"
    })
    
    # Insert audit (GPT-4)
    db_client.insert_audit({
        "audit_id": "audit_gpt4_001",
        "user_id": 12345,
        "contract_address": "AnotherContractAddress123",
        "status": "success",
        "findings": "GPT-4 analysis findings",
        "risk_score": 5,
        "cost_usd": 0.03,
        "tokens_used": 1200,
        "analysis_type": "gpt4"
    })
    
    # Retrieve user audits
    audits = db_client.get_user_audits(12345)
    print(f"\n✅ User Audits: {len(audits)} found")
    for audit in audits:
        print(f"   - {audit['_id']}: {audit['analysis_type']} (${audit['cost_usd']:.2f})")
    
    # Set subscription
    db_client.set_subscription(12345, "subscriber", 30)
    
    # Get active subscription
    sub = db_client.get_active_subscription(12345)
    if sub:
        print(f"\n✅ Active Subscription: {sub['tier']} tier (expires {sub['expires_at'][:10]})")
    
    # Quota stats
    quota = db_client.get_quota_stats(12345)
    print(f"\n📊 Quota Stats:")
    print(f"   Audits this month: {quota['audits_this_month']}")
    print(f"   Cost this month: ${quota['cost_this_month_usd']:.2f}")
    
    # Health check
    health = db_client.health_check()
    print(f"\n🏥 Database Health:")
    print(f"   Status: {health['status']}")
    print(f"   Mode: {health.get('mode', 'unknown')}")
    print(f"   Users: {health.get('users_count', 0)}")
    print(f"   Audits: {health.get('audits_count', 0)}")
    print(f"   Subscriptions: {health.get('subscriptions_count', 0)}")
    
    print("\n✅ Phase 3c MongoDB client test complete!")
