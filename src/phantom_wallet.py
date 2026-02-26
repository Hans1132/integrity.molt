"""
Phantom Wallet Integration for integrity.molt
Handles wallet connection, transaction signing, and blockchain confirmation
Supports both signing NFTs and payments on Solana mainnet
"""
import logging
import json
from typing import Dict, Any, Optional
from dataclasses import dataclass
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)


@dataclass
class WalletSession:
    """Active wallet connection session"""
    user_id: int
    wallet_address: str
    session_token: str
    created_at: datetime
    expires_at: datetime
    confirmed: bool = False


class PhantomWalletClient:
    """
    Manages Phantom wallet connections and transaction signing
    
    Phase 3 Implementation:
    - Create signing requests (user must confirm in Phantom app)
    - Verify transaction confirmation on Solana RPC
    - Store wallet sessions per user
    - Handle transaction timeouts and retries
    """
    
    # Phantom Deep Links for mobile app
    PHANTOM_BASE_URL = "https://phantom.app"
    PHANTOM_DEEP_LINK = "phantom://browse"
    
    # Transaction constants
    TRANSACTION_TIMEOUT_SECONDS = 300  # 5 minutes
    MAX_RETRIES = 3
    RETRY_DELAY_MS = 2000
    
    # Solana network constants
    SOLANA_RPC_ENDPOINT = "https://api.mainnet-beta.solana.com"
    METAPLEX_PROGRAM_ID = "Auth1qJ3xEKJooZuvgqTwu7wtd8A4bEv3dLVmAEMBvuR"
    
    def __init__(self):
        """Initialize Phantom wallet client"""
        self.sessions: Dict[int, WalletSession] = {}  # user_id -> WalletSession
        self.pending_signatures: Dict[str, Dict[str, Any]] = {}  # tx_hash -> metadata
        self.confirmed_transactions: Dict[str, Dict[str, Any]] = {}  # tx_hash -> confirmation
        logger.info("✅ Phantom Wallet Client initialized")
    
    def create_signing_request(
        self,
        user_id: int,
        transaction_type: str,  # "nft_audit", "payment_audit", "subscription"
        amount_lamports: int,
        contract_address: str,
        metadata: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Create a signing request for Phantom wallet
        User must confirm in Phantom app
        
        Args:
            user_id: Telegram user ID
            transaction_type: Type of transaction to sign
            amount_lamports: Amount in lamports (1 SOL = 1B lamports)
            contract_address: Target contract/NFT address
            metadata: Transaction metadata (audit hash, payment ID, etc.)
        
        Returns:
            dict with signing request details
        """
        try:
            # For Phase 3: Generate request token
            import time
            request_id = f"sign_req_{user_id}_{int(time.time())}"
            
            # Create transaction instruction (Metaplex or Token program)
            signing_request = {
                "status": "pending_phantom_confirmation",
                "request_id": request_id,
                "user_id": user_id,
                "transaction_type": transaction_type,
                "amount_lamports": amount_lamports,
                "amount_sol": amount_lamports / 1_000_000_000,
                "contract_address": contract_address,
                "metadata": metadata,
                "created_at": datetime.utcnow().isoformat(),
                "expires_at": (datetime.utcnow() + timedelta(seconds=self.TRANSACTION_TIMEOUT_SECONDS)).isoformat(),
                "phase": "3-pending-phantom-confirmation",
                "deeplink": self._generate_phantom_deeplink(
                    transaction_type,
                    amount_lamports,
                    contract_address
                ),
                "instructions": {
                    "step1": "Open Phantom wallet app or browser extension",
                    "step2": "Review transaction details",
                    "step3": "Tap 'Approve' to sign",
                    "step4": "Waiting for blockchain confirmation..."
                }
            }
            
            # Store pending request
            self.pending_signatures[request_id] = signing_request
            
            logger.info(
                f"📝 Signing request created: {request_id} | "
                f"Type: {transaction_type} | Account: {user_id} | "
                f"Amount: {amount_lamports} lamports"
            )
            
            return signing_request
        
        except Exception as e:
            logger.error(f"❌ Signing request creation failed: {e}")
            return {
                "status": "error",
                "error": str(e)
            }
    
    def _generate_phantom_deeplink(
        self,
        transaction_type: str,
        amount_lamports: int,
        contract_address: str
    ) -> str:
        """
        Generate Phantom deep link for transaction signing
        Format: phantom://browse?request_type=signTransaction&...
        
        Args:
            transaction_type: Type of transaction
            amount_lamports: Amount in lamports
            contract_address: Target address
        
        Returns:
            Deep link URL for Phantom app
        """
        # Phase 3: This will be enhanced with actual Metaplex instructions
        # For now, returns a placeholder deep link
        deeplink = (
            f"{self.PHANTOM_DEEP_LINK}?request_type=signTransaction"
            f"&amount={amount_lamports}"
            f"&recipient={contract_address}"
            f"&type={transaction_type}"
        )
        return deeplink
    
    def confirm_signature(
        self,
        request_id: str,
        transaction_hash: str,
        signature: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Confirm user signed the transaction in Phantom
        (Phase 3: Will verify with Solana RPC)
        
        Args:
            request_id: Original signing request ID
            transaction_hash: Solana transaction hash
            signature: User signature (optional, for validation)
        
        Returns:
            Confirmation dict
        """
        try:
            if request_id not in self.pending_signatures:
                return {
                    "status": "error",
                    "error": f"Request {request_id} not found"
                }
            
            request = self.pending_signatures[request_id]
            
            # Check expiry
            expiry = datetime.fromisoformat(request["expires_at"])
            if datetime.utcnow() > expiry:
                del self.pending_signatures[request_id]
                return {
                    "status": "expired",
                    "message": "Signing request expired (5 minutes)"
                }
            
            # Mark as confirmed
            confirmation = {
                "status": "signed",
                "request_id": request_id,
                "transaction_hash": transaction_hash,
                "transaction_type": request["transaction_type"],
                "user_id": request["user_id"],
                "amount_sol": request["amount_sol"],
                "confirmed_at": datetime.utcnow().isoformat(),
                "phase": "3-verifying-blockchain",
                "next_step": "Waiting for Solana blockchain confirmation..."
            }
            
            # Store confirmed transaction
            self.confirmed_transactions[transaction_hash] = confirmation
            del self.pending_signatures[request_id]
            
            logger.info(
                f"✅ Signature confirmed: {request_id} | "
                f"Tx: {transaction_hash[:16]}... | "
                f"User: {request['user_id']}"
            )
            
            # Phase 3: Would call verify_transaction_confirmed() here
            return confirmation
        
        except Exception as e:
            logger.error(f"❌ Signature confirmation failed: {e}")
            return {
                "status": "error",
                "error": str(e)
            }
    
    def verify_transaction_confirmed(
        self,
        transaction_hash: str,
        timeout_seconds: int = 60
    ) -> Dict[str, Any]:
        """
        Verify transaction confirmed on Solana blockchain
        (Phase 3: Calls Solana RPC getSignatureStatus)
        
        Args:
            transaction_hash: Solana transaction hash
            timeout_seconds: Max seconds to wait for confirmation
        
        Returns:
            Confirmation dict with blockchain details
        """
        try:
            if transaction_hash not in self.confirmed_transactions:
                return {
                    "status": "error",
                    "error": f"Transaction {transaction_hash} not found"
                }
            
            tx_data = self.confirmed_transactions[transaction_hash]
            
            # Phase 3: Call Solana RPC
            # from src.solana_client import solana_client
            # rpc_result = solana_client.get_transaction_status(transaction_hash)
            
            # For now, return pending status
            verification = {
                "status": "pending",  # pending -> confirmed -> finalized
                "transaction_hash": transaction_hash,
                "user_id": tx_data["user_id"],
                "amount_sol": tx_data["amount_sol"],
                "transaction_type": tx_data["transaction_type"],
                "signed_at": tx_data["confirmed_at"],
                "solscan_link": f"https://solscan.io/tx/{transaction_hash}",
                "phase": "3-awaiting-blockchain-confirmation",
                "message": "Transaction pending blockchain confirmation (usually 10-30 seconds)..."
            }
            
            logger.info(
                f"🔍 Verifying transaction: {transaction_hash[:16]}... | "
                f"Status: {verification['status']}"
            )
            
            return verification
        
        except Exception as e:
            logger.error(f"❌ Transaction verification failed: {e}")
            return {
                "status": "error",
                "error": str(e)
            }
    
    def get_session_status(self, user_id: int) -> Dict[str, Any]:
        """
        Get user's wallet session and any pending transactions
        
        Args:
            user_id: Telegram user ID
        
        Returns:
            Session status dict
        """
        try:
            session = self.sessions.get(user_id)
            
            # Find any pending signatures for this user
            pending = [
                req for req in self.pending_signatures.values()
                if req.get("user_id") == user_id
            ]
            
            return {
                "user_id": user_id,
                "wallet_connected": session is not None,
                "wallet_address": session.wallet_address if session else None,
                "pending_signatures": len(pending),
                "pending_requests": pending
            }
        
        except Exception as e:
            logger.error(f"❌ Failed to get session status: {e}")
            return {
                "status": "error",
                "error": str(e)
            }
    
    def disconnect_wallet(self, user_id: int) -> Dict[str, Any]:
        """
        Disconnect user's wallet session
        
        Args:
            user_id: Telegram user ID
        
        Returns:
            Disconnection result
        """
        try:
            if user_id in self.sessions:
                session = self.sessions[user_id]
                del self.sessions[user_id]
                
                logger.info(
                    f"🔌 Wallet disconnected: User {user_id} | "
                    f"Address: {session.wallet_address[:16]}..."
                )
                
                return {
                    "status": "disconnected",
                    "user_id": user_id,
                    "wallet_address": session.wallet_address
                }
            
            return {
                "status": "not_connected",
                "user_id": user_id,
                "message": "No active wallet session"
            }
        
        except Exception as e:
            logger.error(f"❌ Wallet disconnection failed: {e}")
            return {
                "status": "error",
                "error": str(e)
            }


# Global instance
phantom_wallet = PhantomWalletClient()


if __name__ == "__main__":
    # Test Phantom wallet client
    print("Testing Phantom Wallet Client...")
    print("=" * 50)
    
    # Create signing request
    request = phantom_wallet.create_signing_request(
        user_id=12345,
        transaction_type="nft_audit",
        amount_lamports=5000000,  # 0.005 SOL
        contract_address="EvXNCtaoVuC1NQLQswAnqsbQKPgVTdjrrLKa8MpMJiLf",
        metadata={"audit_id": "audit_123", "risk_score": 7}
    )
    print(f"\n1. Signing Request Created:")
    print(f"  Status: {request['status']}")
    print(f"  Request ID: {request['request_id']}")
    print(f"  Type: {request['transaction_type']}")
    print(f"  Amount: {request['amount_sol']} SOL")
    
    # Confirm signature
    if request['status'] != 'error':
        confirmation = phantom_wallet.confirm_signature(
            request_id=request['request_id'],
            transaction_hash="5KMxXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        )
        print(f"\n2. Signature Confirmed:")
        print(f"  Status: {confirmation['status']}")
        print(f"  Tx: {confirmation['transaction_hash'][:16]}...")
        
        # Verify blockchain confirmation
        verification = phantom_wallet.verify_transaction_confirmed(
            transaction_hash=confirmation['transaction_hash']
        )
        print(f"\n3. Blockchain Verification:")
        print(f"  Status: {verification['status']}")
        print(f"  Solscan: {verification['solscan_link']}")
    
    print("\n✅ Phantom wallet test complete!")
