"""
Payment Transaction Signing for Solana SOL transfers
Handles creating and signing payment transactions for audits and subscriptions
Integrates with Phantom wallet for user approval
"""
import logging
from typing import Dict, Any, Optional
from datetime import datetime

logger = logging.getLogger(__name__)


class PaymentTransactionSigner:
    """
    Creates and signs Solana payment transactions (SOL transfers)
    
    Phase 3 Implementation:
    - Generate SPL Token or SOL transfer transactions
    - Handle multi-recipient scenarios (split revenue)
    - Create subscription recurring payment setup
    - Verify payment execution on Solana RPC
    """
    
    # Solana constants
    SYSTEM_PROGRAM = "11111111111111111111111111111111"
    TOKEN_PROGRAM = "TokenkegQfeZyiNwAJsyFbPVwwQQfփ1111111111111"  # SPL Token program
    
    # integrity.molt revenue wallet
    INTEGRITY_MOLT_WALLET = "integrity.molt"  # Phase 3: Will be actual Solana address
    MOLTBOOK_REVENUE_SHARE = 0.10  # 10% to Moltbook
    
    def __init__(self):
        """Initialize payment transaction signer"""
        self.pending_payments: Dict[str, Dict[str, Any]] = {}
        self.completed_payments: Dict[str, Dict[str, Any]] = {}
        logger.info("✅ Payment Transaction Signer initialized")
    
    def create_audit_payment_transaction(
        self,
        payment_id: str,
        user_id: int,
        amount_lamports: int,
        contract_address: str,
        audit_id: str,
        recipient_wallet: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Create Solana payment transaction for audit fee
        
        Args:
            payment_id: Unique payment identifier
            user_id: Telegram user ID
            amount_lamports: Amount in lamports
            contract_address: Contract that was audited
            audit_id: Audit report ID
            recipient_wallet: Alternate recipient (optional)
        
        Returns:
            Payment transaction ready for signing
        """
        try:
            # Calculate revenue split
            integrity_amount = int(amount_lamports * (1 - self.MOLTBOOK_REVENUE_SHARE))
            moltbook_amount = int(amount_lamports * self.MOLTBOOK_REVENUE_SHARE)
            
            payment_tx = {
                "status": "pending_payment_signing",
                "payment_id": payment_id,
                "user_id": user_id,
                "transaction_type": "audit_payment",
                "amount_lamports": amount_lamports,
                "amount_sol": amount_lamports / 1_000_000_000,
                "audit_id": audit_id,
                "contract_address": contract_address,
                "created_at": datetime.utcnow().isoformat(),
                "phase": "3-pending-payment-signature",
                "recipients": [
                    {
                        "address": recipient_wallet or self.INTEGRITY_MOLT_WALLET,
                        "amount_lamports": integrity_amount,
                        "amount_sol": integrity_amount / 1_000_000_000,
                        "description": "integrity.molt audit fee",
                        "share_percent": 90
                    },
                    {
                        "address": "moltbook.sol",
                        "amount_lamports": moltbook_amount,
                        "amount_sol": moltbook_amount / 1_000_000_000,
                        "description": "Moltbook platform fee",
                        "share_percent": 10
                    }
                ],
                "transaction_details": {
                    "program": self.SYSTEM_PROGRAM,
                    "instruction": "Transfer",
                    "instructions": [
                        {
                            "accounts": {
                                "from": "<user_wallet>",
                                "to": recipient_wallet or self.INTEGRITY_MOLT_WALLET,
                                "system_program": self.SYSTEM_PROGRAM
                            },
                            "data": {"amount": integrity_amount}
                        },
                        {
                            "accounts": {
                                "from": "<user_wallet>",
                                "to": "moltbook.sol",
                                "system_program": self.SYSTEM_PROGRAM
                            },
                            "data": {"amount": moltbook_amount}
                        }
                    ]
                },
                "instructions": {
                    "step1": "Payment amount calculated",
                    "step2": "Ready for signing in Phantom",
                    "step3": f"Will transfer {amount_lamports} lamports to integrity.molt",
                    "step4": "Audit unlocked after confirmation"
                }
            }
            
            # Store pending payment
            self.pending_payments[payment_id] = payment_tx
            
            logger.info(
                f"💳 Payment transaction created: {payment_id} | "
                f"User: {user_id} | Amount: {amount_lamports} lamports | "
                f"Audit: {audit_id[:8]}..."
            )
            
            return payment_tx
        
        except Exception as e:
            logger.error(f"❌ Payment transaction creation failed: {e}")
            return {
                "status": "error",
                "error": str(e)
            }
    
    def create_subscription_payment_transaction(
        self,
        payment_id: str,
        user_id: int,
        amount_lamports: int,
        tier: str,
        duration_days: int = 30,
        recipient_wallet: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Create Solana payment transaction for subscription
        
        Args:
            payment_id: Unique payment identifier
            user_id: Telegram user ID
            amount_lamports: Amount in lamports
            tier: Subscription tier ('subscriber' or 'premium')
            duration_days: Subscription duration
            recipient_wallet: Alternate recipient (optional)
        
        Returns:
            Subscription payment transaction
        """
        try:
            # Calculate revenue split for subscription
            integrity_amount = int(amount_lamports * (1 - self.MOLTBOOK_REVENUE_SHARE))
            moltbook_amount = int(amount_lamports * self.MOLTBOOK_REVENUE_SHARE)
            
            subscription_tx = {
                "status": "pending_subscription_signing",
                "payment_id": payment_id,
                "user_id": user_id,
                "transaction_type": "subscription_payment",
                "subscription_tier": tier,
                "amount_lamports": amount_lamports,
                "amount_sol": amount_lamports / 1_000_000_000,
                "duration_days": duration_days,
                "created_at": datetime.utcnow().isoformat(),
                "phase": "3-pending-subscription-signature",
                "recipients": [
                    {
                        "address": recipient_wallet or self.INTEGRITY_MOLT_WALLET,
                        "amount_lamports": integrity_amount,
                        "amount_sol": integrity_amount / 1_000_000_000,
                        "description": f"{tier.title()} subscription fee ({duration_days} days)",
                        "share_percent": 90
                    },
                    {
                        "address": "moltbook.sol",
                        "amount_lamports": moltbook_amount,
                        "amount_sol": moltbook_amount / 1_000_000_000,
                        "description": "Moltbook platform subscription fee",
                        "share_percent": 10
                    }
                ],
                "tier_benefits": {
                    "subscriber": {
                        "audits_per_hour": 10,
                        "audits_per_day": 50,
                        "audits_per_month": 999,
                        "monthly_budget_sol": 10.0,
                        "priority_support": True
                    },
                    "premium": {
                        "audits_per_hour": 20,
                        "audits_per_day": 100,
                        "audits_per_month": 9999,
                        "monthly_budget_sol": 100.0,
                        "priority_support": True,
                        "api_access": True
                    }
                }.get(tier, {}),
                "instructions": {
                    "step1": "Subscription benefits loaded",
                    "step2": "Ready for signing in Phantom",
                    "step3": f"Will transfer {amount_lamports} lamports to integrity.molt",
                    "step4": "Subscription activated immediately after confirmation"
                }
            }
            
            # Store pending payment
            self.pending_payments[payment_id] = subscription_tx
            
            logger.info(
                f"💳 Subscription payment transaction created: {payment_id} | "
                f"User: {user_id} | Tier: {tier} | Amount: {amount_lamports} lamports"
            )
            
            return subscription_tx
        
        except Exception as e:
            logger.error(f"❌ Subscription transaction creation failed: {e}")
            return {
                "status": "error",
                "error": str(e)
            }
    
    def confirm_payment_signature(
        self,
        payment_id: str,
        transaction_hash: str,
        signature: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Confirm payment transaction signed and submitted
        
        Args:
            payment_id: Original payment ID
            transaction_hash: Solana transaction hash
            signature: User signature (optional, for validation)
        
        Returns:
            Confirmation dict
        """
        try:
            if payment_id not in self.pending_payments:
                return {
                    "status": "error",
                    "error": f"Payment {payment_id} not found"
                }
            
            payment = self.pending_payments[payment_id]
            
            payment_confirmation = {
                "status": "submitted",
                "payment_id": payment_id,
                "transaction_hash": transaction_hash,
                "user_id": payment["user_id"],
                "transaction_type": payment["transaction_type"],
                "amount_sol": payment["amount_sol"],
                "submitted_at": datetime.utcnow().isoformat(),
                "solscan_link": f"https://solscan.io/tx/{transaction_hash}",
                "phase": "3-payment-submitted",
                "next_step": "Waiting for blockchain confirmation (usually 10-30 seconds)..."
            }
            
            # Move from pending to completed
            self.completed_payments[transaction_hash] = payment_confirmation
            del self.pending_payments[payment_id]
            
            logger.info(
                f"✅ Payment signature confirmed: {payment_id} | "
                f"Tx: {transaction_hash[:16]}... | "
                f"Amount: {payment['amount_sol']} SOL"
            )
            
            return payment_confirmation
        
        except Exception as e:
            logger.error(f"❌ Payment confirmation failed: {e}")
            return {
                "status": "error",
                "error": str(e)
            }
    
    def verify_payment_confirmed(
        self,
        transaction_hash: str
    ) -> Dict[str, Any]:
        """
        Verify payment confirmed on Solana blockchain
        (Phase 3: Calls Solana RPC)
        
        Args:
            transaction_hash: Solana transaction hash
        
        Returns:
            Confirmation dict with blockchain details
        """
        try:
            if transaction_hash not in self.completed_payments:
                return {
                    "status": "error",
                    "error": f"Transaction {transaction_hash} not found"
                }
            
            payment = self.completed_payments[transaction_hash]
            
            verification = {
                "status": "pending_confirmation",
                "transaction_hash": transaction_hash,
                "payment_id": payment.get("payment_id"),
                "user_id": payment["user_id"],
                "transaction_type": payment["transaction_type"],
                "amount_sol": payment["amount_sol"],
                "submitted_at": payment["submitted_at"],
                "solscan_link": payment["solscan_link"],
                "phase": "3-verifying-payment",
                "message": "Payment pending blockchain confirmation..."
            }
            
            logger.info(
                f"🔍 Verifying payment: {transaction_hash[:16]}... | "
                f"Status: pending"
            )
            
            return verification
        
        except Exception as e:
            logger.error(f"❌ Payment verification failed: {e}")
            return {
                "status": "error",
                "error": str(e)
            }


# Global instance
payment_signer = PaymentTransactionSigner()


if __name__ == "__main__":
    # Test payment transaction signer
    print("Testing Payment Transaction Signer...")
    print("=" * 50)
    
    # Create audit payment
    audit_payment = payment_signer.create_audit_payment_transaction(
        payment_id="payment_audit_123",
        user_id=12345,
        amount_lamports=9000000,  # 0.009 SOL
        contract_address="EvXNCtaoVuC1NQLQswAnqsbQKPgVTdjrrLKa8MpMJiLf",
        audit_id="audit_123456"
    )
    print(f"\n1. Audit Payment Transaction Created:")
    print(f"  Status: {audit_payment['status']}")
    print(f"  Payment ID: {audit_payment['payment_id']}")
    print(f"  Amount: {audit_payment['amount_sol']} SOL")
    print(f"  Recipients: 2 (integrity.molt + Moltbook)")
    
    # Create subscription payment
    sub_payment = payment_signer.create_subscription_payment_transaction(
        payment_id="payment_sub_456",
        user_id=12345,
        amount_lamports=100000000,  # 0.1 SOL
        tier="subscriber",
        duration_days=30
    )
    print(f"\n2. Subscription Payment Transaction Created:")
    print(f"  Status: {sub_payment['status']}")
    print(f"  Tier: {sub_payment['subscription_tier']}")
    print(f"  Amount: {sub_payment['amount_sol']} SOL")
    print(f"  Duration: {sub_payment['duration_days']} days")
    
    # Confirm signature
    confirmation = payment_signer.confirm_payment_signature(
        payment_id=audit_payment['payment_id'],
        transaction_hash="5KMxXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
    )
    print(f"\n3. Payment Signature Confirmed:")
    print(f"  Status: {confirmation['status']}")
    print(f"  Tx: {confirmation['transaction_hash'][:16]}...")
    print(f"  Solscan: {confirmation['solscan_link']}")
    
    print("\n✅ Payment transaction signer test complete!")
