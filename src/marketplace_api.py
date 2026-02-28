"""
Marketplace API for integrity.molt
FastAPI server for receiving audit requests from Moltbook
Handles autonomous audit execution and SOL payment processing
"""
import logging
import asyncio
from typing import Dict, Any, Optional
from datetime import datetime
from fastapi import FastAPI, HTTPException, BackgroundTasks, Request, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import hmac
import hashlib
import json

from src.config import Config
from src.security_auditor import SecurityAuditor, format_audit_report
from src.payment_processor import PaymentProcessor
from src.solana_rpc import SolanaRPCClient
from src.moltbook_integration import MoltbookIntegration
from src.agent_config import AgentConfig

logger = logging.getLogger(__name__)


# ============================================================================
# PYDANTIC MODELS - Request/Response schemas
# ============================================================================

class AuditRequest(BaseModel):
    """Incoming audit request from Moltbook"""
    contract_address: str
    requester_wallet: str
    amount_lamports: int
    payment_tx_hash: str
    request_id: str
    metadata: Optional[Dict[str, Any]] = None


class AuditResponse(BaseModel):
    """Audit response to Moltbook"""
    status: str
    audit_id: str
    risk_score: int
    findings_count: int
    report_url: str
    cost_sol: float
    timestamp: str


class PaymentVerification(BaseModel):
    """Verify payment was made"""
    transaction_hash: str
    amount_lamports: int
    recipient: str
    status: str


class MarketplaceEvent(BaseModel):
    """Generic Moltbook marketplace event"""
    event_type: str
    timestamp: str
    data: Dict[str, Any]


# ============================================================================
# FASTAPI APPLICATION SETUP
# ============================================================================

app = FastAPI(
    title="integrity.molt Marketplace API",
    description="Autonomous security audit agent on Moltbook",
    version="3.0.0"
)


# Initialize components
payment_processor = PaymentProcessor()
solana_client = SolanaRPCClient(network="mainnet")
moltbook_integration = MoltbookIntegration()
agent_identity = AgentConfig()


# ============================================================================
# SECURITY - HMAC Signature Verification
# ============================================================================

def verify_moltbook_signature(
    payload: bytes,
    signature: str,
    secret: Optional[str] = None
) -> bool:
    """
    Verify HMAC-SHA256 signature from Moltbook
    
    Args:
        payload: Request body bytes
        signature: Signature from X-Moltbook-Signature header
        secret: Shared secret (from Config or param)
    
    Returns:
        True if valid signature
    """
    secret = secret or Config.MOLTBOOK_WEBHOOK_SECRET
    if not secret:
        logger.warning("Moltbook webhook secret not configured")
        return False
    
    expected = hmac.new(
        secret.encode(),
        payload,
        hashlib.sha256
    ).hexdigest()
    
    return hmac.compare_digest(expected, signature)


# ============================================================================
# HEALTH CHECK ENDPOINTS
# ============================================================================

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "agent": "integrity.molt",
        "environment": Config.ENVIRONMENT,
        "timestamp": datetime.utcnow().isoformat()
    }


@app.get("/status")
async def agent_status():
    """Agent status and statistics"""
    return {
        "status": "active",
        "agent_id": Config.MOLTBOOK_AGENT_ID,
        "agent_wallet": Config.AGENT_WALLET,
        "identity_nft": Config.AGENT_IDENTITY_NFT,
        "marketplace": "moltbook",
        "network": "solana-mainnet",
        "timestamp": datetime.utcnow().isoformat()
    }


# ============================================================================
# MARKETPLACE ENDPOINTS
# ============================================================================

@app.post("/webhooks/audit")
async def receive_audit_request(
    request: Request,
    background_tasks: BackgroundTasks,
    x_moltbook_signature: Optional[str] = Header(None)
) -> Dict[str, Any]:
    """
    Receive audit request from Moltbook marketplace
    
    Expected payload:
    {
        "contract_address": "EvXNCtaoVuC1NQLQswAnqsbQKPgVTdjrrLKa8MpMJiLf",
        "requester_wallet": "wallet...",
        "amount_lamports": 5000000,
        "payment_tx_hash": "4mxjnyq8bMZEhLF...",
        "request_id": "req_123_456",
        "metadata": {...}
    }
    
    Returns:
        Audit response with findings
    """
    try:
        # Get raw body for signature verification
        body = await request.body()
        
        # Verify Moltbook signature
        if x_moltbook_signature:
            if not verify_moltbook_signature(body, x_moltbook_signature):
                logger.warning(f"❌ Invalid Moltbook signature")
                raise HTTPException(status_code=401, detail="Invalid signature")
        
        # Parse request
        audit_req = AuditRequest(**json.loads(body))
        
        logger.info(
            f"📊 Audit request received:\n"
            f"  Contract: {audit_req.contract_address[:12]}...\n"
            f"  Amount: {audit_req.amount_lamports} lamports\n"
            f"  Payment TX: {audit_req.payment_tx_hash[:16]}..."
        )
        
        # **CRITICAL STEP**: Verify payment on Solana before running audit
        payment_verified = await verify_payment_on_chain(audit_req)
        
        if not payment_verified:
            logger.error(f"❌ Payment verification failed for {audit_req.request_id}")
            raise HTTPException(
                status_code=402,
                detail="Payment verification failed"
            )
        
        # ✅ Payment verified - now run audit autonomously
        background_tasks.add_task(
            autonomous_audit_workflow,
            audit_req
        )
        
        # Return immediate acknowledgment
        return {
            "status": "received",
            "request_id": audit_req.request_id,
            "message": "Audit queued - processing in background",
            "estimated_time_seconds": 30
        }
    
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid request: {str(e)}")
    except Exception as e:
        logger.error(f"❌ Audit request error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error")


@app.post("/webhooks/payment-confirm")
async def payment_confirmation(
    verification: PaymentVerification,
    x_moltbook_signature: Optional[str] = Header(None)
) -> Dict[str, Any]:
    """
    Receive payment confirmation from Moltbook
    Triggers audit execution after payment confirmed
    """
    try:
        if x_moltbook_signature:
            body = json.dumps(verification.dict()).encode()
            if not verify_moltbook_signature(body, x_moltbook_signature):
                raise HTTPException(status_code=401, detail="Invalid signature")
        
        logger.info(
            f"💳 Payment confirmed: {verification.transaction_hash[:16]}...\n"
            f"   Amount: {verification.amount_lamports} lamports"
        )
        
        # Verify on-chain
        tx_verified = solana_client.verify_transaction_confirmed(
            verification.transaction_hash
        )
        
        return {
            "status": "confirmed",
            "transaction_hash": verification.transaction_hash,
            "verified_on_chain": tx_verified.get("status") == "confirmed"
        }
    
    except Exception as e:
        logger.error(f"Payment confirmation error: {e}")
        raise HTTPException(status_code=500, detail="Payment confirmation failed")


@app.post("/webhooks/marketplace-event")
async def handle_marketplace_event(
    event: MarketplaceEvent,
    x_moltbook_signature: Optional[str] = Header(None)
) -> Dict[str, Any]:
    """
    Handle generic Moltbook marketplace events
    (e.g., subscription updates, audit requests, etc.)
    """
    try:
        logger.info(f"📢 Marketplace event: {event.event_type}")
        
        if event.event_type == "audit_request":
            # Handle audit request
            return {"status": "processed", "event": event.event_type}
        
        elif event.event_type == "subscription_update":
            # Handle subscription changes
            return {"status": "processed", "event": event.event_type}
        
        else:
            logger.debug(f"Unknown event type: {event.event_type}")
            return {"status": "acknowledged", "event": event.event_type}
    
    except Exception as e:
        logger.error(f"Marketplace event error: {e}")
        raise HTTPException(status_code=500, detail="Event processing failed")


# ============================================================================
# REPORTING ENDPOINTS
# ============================================================================

@app.get("/reports/{audit_id}")
async def get_audit_report(audit_id: str) -> Dict[str, Any]:
    """
    Retrieve completed audit report
    Public endpoint - anyone can view (reports are anonymized)
    """
    try:
        # TODO: Retrieve from database/storage
        return {
            "status": "not_found",
            "audit_id": audit_id
        }
    except Exception as e:
        raise HTTPException(status_code=404, detail="Report not found")


@app.get("/earnings")
async def get_agent_earnings() -> Dict[str, Any]:
    """
    Get agent earnings dashboard
    Public endpoint - shows real-time SOL earnings
    """
    return {
        "agent": "integrity.molt",
        "period": "all-time",
        "total_audits": 0,
        "total_earnings_sol": 0.0,
        "total_earnings_usd": 0.0,
        "average_per_audit_sol": 0.0,
        "timestamp": datetime.utcnow().isoformat()
    }


# ============================================================================
# INTERNAL ASYNC FUNCTIONS
# ============================================================================

async def verify_payment_on_chain(
    audit_req: AuditRequest
) -> bool:
    """
    Verify payment was actually made on Solana blockchain
    CRITICAL: This prevents free audit exploitation
    
    Args:
        audit_req: Incoming audit request with payment details
    
    Returns:
        True if payment confirmed, False otherwise
    """
    try:
        # Verify transaction on Solana
        tx_verification = solana_client.verify_transaction_confirmed(
            audit_req.payment_tx_hash
        )
        
        if tx_verification.get("status") != "confirmed":
            logger.error(f"Transaction not confirmed: {audit_req.payment_tx_hash}")
            return False
        
        # Verify amount matches
        if tx_verification.get("amount") != audit_req.amount_lamports:
            logger.error(f"Amount mismatch: expected {audit_req.amount_lamports}, got {tx_verification.get('amount')}")
            return False
        
        # Verify recipient is integrity.molt wallet
        if tx_verification.get("recipient") != Config.AGENT_WALLET:
            logger.error(f"Wrong recipient: {tx_verification.get('recipient')}")
            return False
        
        logger.info(f"✅ Payment verified on-chain for {audit_req.request_id}")
        return True
    
    except Exception as e:
        logger.error(f"Payment verification error: {e}")
        return False


async def autonomous_audit_workflow(audit_req: AuditRequest):
    """
    Execute audit autonomously (no human interaction needed)
    This runs in background after payment verified
    
    Workflow:
    1. Run security analysis with GPT-4
    2. Format report
    3. Save to storage
    4. Anchor on-chain (Metaplex NFT)
    5. Notify Moltbook
    6. Transfer fee to wallet
    """
    try:
        logger.info(f"🤖 Starting autonomous audit for {audit_req.contract_address[:12]}...")
        
        # ========== STEP 1: RUN AUDIT ==========
        audit_result = SecurityAuditor.analyze_contract(
            contract_address=audit_req.contract_address,
            contract_code="",
            user_id=0,  # No user (autonomous)
            is_subscriber=False,
            force_refresh=False
        )
        
        if not audit_result or audit_result.get("status") != "completed":
            logger.error(f"Audit analysis failed: {audit_result}")
            return
        
        # Generate report
        formatted_report = format_audit_report(audit_result)
        
        # ========== STEP 2: ANCHOR ON-CHAIN ==========
        # TODO: Create Metaplex Core NFT with audit report
        audit_nft_mint = f"nft_audit_{audit_req.request_id}"
        
        # ========== STEP 3: SAVE REPORT ==========
        # TODO: Save to R2 or database
        report_url = f"https://integrity.molt.app/reports/{audit_nft_mint}"
        
        # ========== STEP 4: NOTIFY MOLTBOOK ==========
        await moltbook_integration.publish_audit_report(
            audit_id=audit_req.request_id,
            contract_address=audit_req.contract_address,
            risk_score=audit_result.get("risk_score", 5),
            findings=audit_result.get("findings", []),
            report_url=report_url,
            cost_usd=audit_result.get("cost_usd", 0.0),
            user_id=None
        )
        
        # ========== STEP 5: EMIT EARNINGS ==========
        # Fee already transferred by payer (on-chain)
        # Log for dashboard
        logger.info(
            f"✅ Autonomous audit completed!\n"
            f"   Request: {audit_req.request_id}\n"
            f"   Contract: {audit_req.contract_address[:12]}...\n"
            f"   Earnings: {audit_req.amount_lamports / 1_000_000_000:.6f} SOL\n"
            f"   Report: {report_url}"
        )
        
        return {
            "status": "completed",
            "request_id": audit_req.request_id,
            "audit_nft": audit_nft_mint,
            "report_url": report_url
        }
    
    except Exception as e:
        logger.error(f"Autonomous audit workflow error: {e}", exc_info=True)


# ============================================================================
# STARTUP/SHUTDOWN
# ============================================================================

@app.on_event("startup")
async def startup_event():
    """Initialize on server start"""
    logger.info("=" * 60)
    logger.info("🚀 integrity.molt Marketplace API starting...")
    logger.info("=" * 60)
    logger.info(f"Agent ID: {Config.MOLTBOOK_AGENT_ID}")
    logger.info(f"Wallet: {Config.AGENT_WALLET}")
    logger.info(f"Network: Solana Mainnet")


@app.on_event("shutdown")
async def shutdown_event():
    """Cleanup on server shutdown"""
    logger.info("🛑 Marketplace API shutting down...")


if __name__ == "__main__":
    import uvicorn
    
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8000,
        log_level="info"
    )
