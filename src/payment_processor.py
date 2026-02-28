"""
Solana Payment Processing
Handles SOL transactions for security audits on Solana blockchain
"""
import logging
from typing import Optional, Dict, Any
from decimal import Decimal
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)

# Solana constant
LAMPORTS_PER_SOL = 1_000_000_000


class PaymentProcessor:
    """Manages payments for security audits in SOL"""
    
    # Audit pricing model
    PRICING = {
        "base_fee_sol": Decimal("0.05"),  # Base fee: 0.05 SOL (~$3 USD)
        "per_token_cost": Decimal("0.000001"),  # 1 lamport per token
        "risk_multiplier": {
            "1": Decimal("1.0"),   # Low risk: 1x
            "2": Decimal("1.0"),
            "3": Decimal("1.1"),   # Medium: 1.1x
            "4": Decimal("1.1"),
            "5": Decimal("1.2"),
            "6": Decimal("1.5"),   # High: 1.5x
            "7": Decimal("1.8"),
            "8": Decimal("2.0"),   # Critical: 2x
            "9": Decimal("2.5"),
            "10": Decimal("3.0")
        },
        "subscription_monthly_sol": Decimal("0.1")  # Monthly sub: 0.1 SOL (~6 USD)
    }
    
    def __init__(self):
        """Initialize payment processor"""
        self.payment_history = {}  # In-memory (Phase 2), later to DB
        self.pending_payments = {}
        self.subscription_users = set()
    
    def calculate_audit_fee(
        self,
        tokens_used: int,
        risk_score: str,
        is_subscriber: bool = False
    ) -> Dict[str, Any]:
        """
        Calculate audit fee based on complexity
        
        Args:
            tokens_used: GPT-4 tokens used in audit
            risk_score: Risk score (1-10 string)
            is_subscriber: Whether user has active subscription
        
        Returns:
            dict with fee breakdown
        """
        try:
            base_fee = self.PRICING["base_fee_sol"]
            
            # Token cost component
            token_fee = Decimal(tokens_used) * self.PRICING["per_token_cost"] / LAMPORTS_PER_SOL
            
            # Risk multiplier
            risk_mult = self.PRICING["risk_multiplier"].get(
                str(risk_score),
                Decimal("1.0")
            )
            
            # Calculate subtotal
            subtotal = (base_fee + token_fee) * risk_mult
            
            # Apply subscription discount (20% off)
            discount = Decimal("0.0")
            if is_subscriber:
                discount = subtotal * Decimal("0.2")
                subtotal = subtotal - discount
            
            # Convert to lamports for precision
            fee_lamports = int(subtotal * LAMPORTS_PER_SOL)
            
            logger.info(
                f"Fee calculated: Base={base_fee} SOL, Tokens={token_fee:.6f} SOL, "
                f"Risk={risk_mult}x, Discount={discount:.6f} SOL, "
                f"Total: {fee_lamports} lamports ({subtotal:.6f} SOL)"
            )
            
            return {
                "status": "calculated",
                "fee_sol": float(subtotal),
                "fee_lamports": fee_lamports,
                "breakdown": {
                    "base_fee_sol": float(base_fee),
                    "token_fee_sol": float(token_fee),
                    "risk_multiplier": float(risk_mult),
                    "discount_sol": float(discount),
                    "is_subscriber": is_subscriber
                },
                "risk_score": risk_score,
                "tokens_used": tokens_used
            }
        
        except Exception as e:
            logger.error(f"❌ Fee calculation failed: {e}")
            return {
                "status": "error",
                "error": str(e)
            }
    
    def create_payment_request(
        self,
        contract_address: str,
        user_id: int,  # Telegram user ID
        tokens_used: int,
        risk_score: str,
        is_subscriber: bool = False,
        recipient_wallet: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Create payment request for audit
        
        In Phase 2: Generate payment payload
        In Phase 3: Sign and submit to blockchain
        
        Args:
            contract_address: Contract being audited
            user_id: Telegram user ID
            tokens_used: GPT-4 tokens
            risk_score: Audit risk score
            is_subscriber: User subscription status
            recipient_wallet: Wallet to receive payment (defaults to integrity.molt)
        
        Returns:
            Payment request dict
        """
        
        try:
            fee_info = self.calculate_audit_fee(tokens_used, risk_score, is_subscriber)
            if fee_info.get("status") == "error":
                return fee_info
            
            fee_lamports = fee_info["fee_lamports"]
            
            payment_id = f"payment_{user_id}_{int(datetime.utcnow().timestamp())}"
            
            payment_request = {
                "payment_id": payment_id,
                "status": "pending",
                "user_id": user_id,
                "contract_address": contract_address,
                "timestamp": datetime.utcnow().isoformat(),
                "expiry": (datetime.utcnow() + timedelta(minutes=15)).isoformat(),
                "amount_lamports": fee_lamports,
                "amount_sol": fee_info["fee_sol"],
                "fee_breakdown": fee_info["breakdown"],
                "recipient_wallet": recipient_wallet or "integrity.molt",
                "phase": "2-pending-signature",
                "instructions": {
                    "phase2_status": "Payment request generated",
                    "phase3_action": "Sign transaction with user wallet",
                    "phase3_submit": "Submit signed transaction to Solana RPC"
                }
            }
            
            # Store in memory
            self.pending_payments[payment_id] = payment_request
            
            logger.info(
                f"✅ Payment request created: {payment_id} | "
                f"User: {user_id} | Amount: {fee_lamports} lamports"
            )
            
            return payment_request
        
        except Exception as e:
            logger.error(f"❌ Payment request creation failed: {e}")
            return {
                "status": "error",
                "error": str(e)
            }
    
    def create_subscription_payment(
        self,
        user_id: int,
        tier: str = "subscriber",
        recipient_wallet: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Create payment request for subscription tier
        
        Args:
            user_id: Telegram user ID
            tier: Subscription tier ('subscriber' or 'premium')
            recipient_wallet: Recipient wallet address
        
        Returns:
            Payment request dict
        """
        
        try:
            # Determine subscription fee based on tier
            if tier == "premium":
                fee_sol = Decimal("1.0")  # Premium: 1 SOL/month
            else:
                fee_sol = self.PRICING["subscription_monthly_sol"]  # 0.1 SOL
            
            fee_lamports = int(fee_sol * LAMPORTS_PER_SOL)
            
            # Generate payment ID
            import time
            payment_id = f"subscription_{user_id}_{int(time.time())}"
            
            payment_request = {
                "payment_id": payment_id,
                "status": "pending",
                "user_id": user_id,
                "subscription_tier": tier,
                "timestamp": datetime.utcnow().isoformat(),
                "expiry": (datetime.utcnow() + timedelta(minutes=15)).isoformat(),
                "amount_lamports": fee_lamports,
                "amount_sol": float(fee_sol),
                "duration_days": 30,
                "tier_benefits": {
                    "subscriber": {
                        "audits_per_hour": 10,
                        "audits_per_day": 50,
                        "audits_per_month": 999,
                        "monthly_budget_sol": 10.0
                    },
                    "premium": {
                        "audits_per_hour": 20,
                        "audits_per_day": 100,
                        "audits_per_month": 9999,
                        "monthly_budget_sol": 100.0
                    }
                }.get(tier, {}),
                "recipient_wallet": recipient_wallet or "integrity.molt",
                "phase": "2-pending-signature",
                "instructions": {
                    "phase2_status": "Subscription payment request generated",
                    "phase3_action": "Sign subscription transaction with user wallet",
                    "phase3_submit": "Submit signed transaction to Solana RPC"
                }
            }
            
            # Store in memory
            self.pending_payments[payment_id] = payment_request
            
            logger.info(
                f"✅ Subscription payment request created: {payment_id} | "
                f"User: {user_id} | Tier: {tier} | Amount: {fee_lamports} lamports"
            )
            
            return payment_request
        
        except Exception as e:
            logger.error(f"❌ Subscription payment request creation failed: {e}")
            return {
                "status": "error",
                "error": str(e)
            }
    
    def confirm_payment(
        self,
        payment_id: str,
        transaction_hash: Optional[str] = None,
        confirmed_at: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Confirm payment received (Phase 3+)
        
        Args:
            payment_id: Payment request ID
            transaction_hash: Solana transaction hash
            confirmed_at: Timestamp of confirmation
        
        Returns:
            Confirmation dict
        """
        
        if payment_id not in self.pending_payments:
            return {
                "status": "error",
                "error": f"Payment {payment_id} not found"
            }
        
        try:
            payment = self.pending_payments[payment_id]
            
            # Check expiry
            expiry = datetime.fromisoformat(payment["expiry"])
            if datetime.utcnow() > expiry:
                return {
                    "status": "expired",
                    "message": "Payment request expired (15 minutes)"
                }
            
            # Mark as confirmed
            payment["status"] = "confirmed"
            payment["transaction_hash"] = transaction_hash or "pending_hash"
            payment["confirmed_at"] = confirmed_at or datetime.utcnow().isoformat()
            
            # Move to history
            self.payment_history[payment_id] = payment
            del self.pending_payments[payment_id]
            
            logger.info(
                f"✅ Payment confirmed: {payment_id} | "
                f"Tx: {transaction_hash} | "
                f"Amount: {payment['amount_sol']} SOL"
            )
            
            return {
                "status": "confirmed",
                "payment_id": payment_id,
                "amount_sol": payment["amount_sol"],
                "transaction_hash": transaction_hash,
                "confirmed_at": payment["confirmed_at"]
            }
        
        except Exception as e:
            logger.error(f"❌ Payment confirmation failed: {e}")
            return {
                "status": "error",
                "error": str(e)
            }
    
    def add_subscription(
        self,
        user_id: int,
        duration_days: int = 30,
        transaction_hash: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Add subscription for user (monthly audit bundle)
        
        Args:
            user_id: Telegram user ID
            duration_days: Subscription duration
            transaction_hash: Payment transaction hash
        
        Returns:
            Subscription confirmation
        """
        
        try:
            sub_fee = self.PRICING["subscription_monthly_sol"]
            sub_fee_lamports = int(sub_fee * LAMPORTS_PER_SOL)
            
            expiry = datetime.utcnow() + timedelta(days=duration_days)
            
            subscription = {
                "user_id": user_id,
                "status": "active",
                "started_at": datetime.utcnow().isoformat(),
                "expires_at": expiry.isoformat(),
                "duration_days": duration_days,
                "cost_sol": float(sub_fee),
                "cost_lamports": sub_fee_lamports,
                "transaction_hash": transaction_hash,
                "audits_included": 30,  # 30 audits per month
                "audits_used": 0
            }
            
            self.subscription_users.add(user_id)
            
            logger.info(
                f"✅ Subscription added: User {user_id} | "
                f"Expires: {expiry.isoformat()} | "
                f"Cost: {sub_fee} SOL"
            )
            
            return {
                "status": "subscribed",
                "user_id": user_id,
                **subscription
            }
        
        except Exception as e:
            logger.error(f"❌ Subscription failed: {e}")
            return {
                "status": "error",
                "error": str(e)
            }
    
    def get_user_balance_info(self, user_id: int) -> Dict[str, Any]:
        """
        Get user payment and subscription info
        
        Args:
            user_id: Telegram user ID
        
        Returns:
            User balance and subscription status
        """
        
        try:
            # Filter history for user
            user_payments = [
                p for p in self.payment_history.values()
                if p.get("user_id") == user_id
            ]
            
            is_subscriber = user_id in self.subscription_users
            
            total_spent_sol = sum(p.get("amount_sol", 0) for p in user_payments)
            
            return {
                "status": "success",
                "user_id": user_id,
                "is_subscriber": is_subscriber,
                "total_payments": len(user_payments),
                "total_spent_sol": total_spent_sol,
                "audits_completed": len(user_payments),
                "payment_history": user_payments[-5:]  # Last 5 payments
            }
        
        except Exception as e:
            logger.error(f"❌ Failed to get user info: {e}")
            return {
                "status": "error",
                "error": str(e)
            }


# Global payment processor instance
payment_processor = PaymentProcessor()


def calculate_audit_fee(tokens_used: int, risk_score: str, is_subscriber: bool = False) -> Dict:
    """Convenience function"""
    return payment_processor.calculate_audit_fee(tokens_used, risk_score, is_subscriber)


def create_payment_request(
    contract_address: str,
    user_id: int,
    tokens_used: int,
    risk_score: str,
    is_subscriber: bool = False
) -> Dict:
    """Convenience function"""
    return payment_processor.create_payment_request(
        contract_address, user_id, tokens_used, risk_score, is_subscriber
    )


if __name__ == "__main__":
    # Test payment processing
    print("Testing Payment Processor...")
    
    # Test fee calculation
    fee = calculate_audit_fee(tokens_used=1234, risk_score="7", is_subscriber=False)
    print(f"\nFee Calculation:\n{fee}\n")
    
    # Test payment request
    payment = create_payment_request(
        contract_address="EvXNCtao...",
        user_id=5940877089,  # Test user ID
        tokens_used=1234,
        risk_score="7",
        is_subscriber=False
    )
    print(f"Payment Request:\n{payment}\n")
    
    # Test subscription
    sub = payment_processor.add_subscription(user_id=5940877089)
    print(f"Subscription:\n{sub}\n")
