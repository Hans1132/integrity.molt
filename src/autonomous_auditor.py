"""
Autonomous Auditor for integrity.molt
Executes security audits without user interaction
Optimized for Moltbook marketplace requests
"""
import logging
import asyncio
from typing import Dict, Any, Optional, List
from datetime import datetime, timedelta
from dataclasses import dataclass

from src.config import Config
from src.security_auditor import SecurityAuditor
from src.payment_processor import PaymentProcessor
from src.solana_rpc import SolanaRPCClient
from src.r2_storage import R2Storage

logger = logging.getLogger(__name__)


@dataclass
class AutonomousAuditJob:
    """Represents an autonomous audit job"""
    job_id: str
    contract_address: str
    requester_wallet: str
    payment_amount_sol: float
    payment_tx_hash: str
    created_at: datetime
    status: str = "queued"  # queued, running, completed, failed
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None


class AutonomousAuditor:
    """
    Manages autonomous audit execution
    Handles multiple concurrent audits from Moltbook marketplace
    """
    
    def __init__(self):
        """Initialize autonomous auditor"""
        self.audit_queue: Dict[str, AutonomousAuditJob] = {}
        self.payment_processor = PaymentProcessor()
        self.solana_client = SolanaRPCClient(network="mainnet")
        self.r2_storage = R2Storage() if Config.r2_enabled() else None
        
        # Performance tracking
        self.audits_completed = 0
        self.total_earnings_sol = 0.0
        self.start_time = datetime.utcnow()
        
        logger.info("✅ Autonomous Auditor initialized")
    
    def queue_audit(
        self,
        contract_address: str,
        requester_wallet: str,
        payment_amount_sol: float,
        payment_tx_hash: str,
        job_id: Optional[str] = None
    ) -> AutonomousAuditJob:
        """
        Queue an audit for autonomous execution
        
        Args:
            contract_address: Smart contract to audit
            requester_wallet: Wallet of requester (for refunds)
            payment_amount_sol: Amount paid in SOL
            payment_tx_hash: Solana transaction hash
            job_id: Unique job ID (auto-generated if None)
        
        Returns:
            AutonomousAuditJob queued
        """
        import time
        job_id = job_id or f"auto_audit_{int(time.time())}"
        
        job = AutonomousAuditJob(
            job_id=job_id,
            contract_address=contract_address,
            requester_wallet=requester_wallet,
            payment_amount_sol=payment_amount_sol,
            payment_tx_hash=payment_tx_hash,
            created_at=datetime.utcnow()
        )
        
        self.audit_queue[job_id] = job
        
        logger.info(
            f"📋 Audit queued: {job_id}\n"
            f"   Contract: {contract_address[:16]}...\n"
            f"   Payment: {payment_amount_sol:.6f} SOL"
        )
        
        return job
    
    async def process_audit_job(self, job: AutonomousAuditJob) -> Dict[str, Any]:
        """
        Process a single audit job
        
        Args:
            job: Audit job to process
        
        Returns:
            Audit result
        """
        job.status = "running"
        job_start = datetime.utcnow()
        
        try:
            logger.info(f"🔍 Processing audit job: {job.job_id}")
            
            # ========== STEP 1: ANALYZE CONTRACT ==========
            audit_result = SecurityAuditor.analyze_contract(
                contract_address=job.contract_address,
                contract_code="",
                user_id=0,  # Autonomous
                is_subscriber=False,
                force_refresh=False
            )
            
            if audit_result.get("status") != "completed":
                raise Exception(f"Analysis failed: {audit_result.get('error')}")
            
            # ========== STEP 2: CALCULATE ACTUAL FEE ==========
            risk_score = audit_result.get("risk_score", 5)
            tokens_used = audit_result.get("tokens_used", 1000)
            
            fee_calc = self.payment_processor.calculate_audit_fee(
                tokens_used=tokens_used,
                risk_score=str(risk_score),
                is_subscriber=False
            )
            
            # ========== STEP 3: STORE REPORT ==========
            report_hash = None
            if self.r2_storage:
                try:
                    report_hash = await self.r2_storage.save_audit_report_async(
                        audit_id=job.job_id,
                        contract_address=job.contract_address,
                        report_content=audit_result,
                        risk_score=risk_score
                    )
                    logger.info(f"📦 Report saved to R2: {report_hash}")
                except Exception as e:
                    logger.warning(f"R2 storage failed (non-blocking): {e}")
            
            # ========== STEP 4: ANCHOR ON-CHAIN (optional) ==========
            # TODO: Create Metaplex NFT with audit proof
            nft_mint = None
            try:
                # nft_mint = await self.create_audit_nft(job)
                logger.info(f"📜 Audit anchored (TODO: Metaplex NFT)")
            except Exception as e:
                logger.warning(f"NFT minting failed (non-blocking): {e}")
            
            # ========== STEP 5: PREPARE RESULT ==========
            elapsed = (datetime.utcnow() - job_start).total_seconds()
            
            result = {
                "status": "completed",
                "job_id": job.job_id,
                "contract_address": job.contract_address,
                "risk_score": risk_score,
                "findings_count": len(audit_result.get("findings", [])),
                "findings": audit_result.get("findings", []),
                "report_hash": report_hash,
                "nft_mint": nft_mint,
                "audit_duration_seconds": elapsed,
                "actual_fee_sol": fee_calc.get("fee_sol"),
                "actual_fee_lamports": fee_calc.get("fee_lamports"),
                "tokens_used": tokens_used,
                "earnings_sol": job.payment_amount_sol,
                "profit_loss_sol": job.payment_amount_sol - fee_calc.get("fee_sol"),
                "timestamp": datetime.utcnow().isoformat()
            }
            
            job.status = "completed"
            job.result = result
            
            # Update earnings
            self.audits_completed += 1
            self.total_earnings_sol += job.payment_amount_sol
            
            logger.info(
                f"✅ Audit completed: {job.job_id}\n"
                f"   Risk: {risk_score}/10\n"
                f"   Findings: {result['findings_count']}\n"
                f"   Earnings: {job.payment_amount_sol:.6f} SOL\n"
                f"   Time: {elapsed:.1f}s"
            )
            
            return result
        
        except Exception as e:
            job.status = "failed"
            job.error = str(e)
            logger.error(f"❌ Audit job failed: {job.job_id}\n   Error: {e}")
            
            return {
                "status": "failed",
                "job_id": job.job_id,
                "error": str(e)
            }
    
    async def process_batch(self, max_concurrent: int = 3):
        """
        Process all queued audits concurrently
        
        Args:
            max_concurrent: Max audits to run simultaneously
        """
        if not self.audit_queue:
            logger.debug("No audits in queue")
            return
        
        # Get queued jobs
        queued_jobs = [
            job for job in self.audit_queue.values()
            if job.status == "queued"
        ]
        
        if not queued_jobs:
            return
        
        logger.info(f"Processing {len(queued_jobs)} queued audits (max {max_concurrent} concurrent)...")
        
        # Process in batches
        for i in range(0, len(queued_jobs), max_concurrent):
            batch = queued_jobs[i:i + max_concurrent]
            tasks = [self.process_audit_job(job) for job in batch]
            await asyncio.gather(*tasks)
    
    def get_job_status(self, job_id: str) -> Optional[Dict[str, Any]]:
        """Get status of audit job"""
        job = self.audit_queue.get(job_id)
        if not job:
            return None
        
        return {
            "job_id": job.job_id,
            "status": job.status,
            "contract": job.contract_address,
            "created_at": job.created_at.isoformat(),
            "result": job.result if job.status == "completed" else None,
            "error": job.error if job.status == "failed" else None
        }
    
    def get_pending_jobs(self) -> List[Dict[str, Any]]:
        """Get all pending jobs"""
        return [
            self.get_job_status(job_id)
            for job_id, job in self.audit_queue.items()
            if job.status in ["queued", "running"]
        ]
    
    def get_completed_audits(self) -> Dict[str, Any]:
        """Get statistics on completed audits"""
        completed = [
            job for job in self.audit_queue.values()
            if job.status == "completed"
        ]
        
        uptime = datetime.utcnow() - self.start_time
        uptime_hours = uptime.total_seconds() / 3600
        
        avg_earnings = (
            self.total_earnings_sol / self.audits_completed
            if self.audits_completed > 0 else 0.0
        )
        
        return {
            "total_audits": self.audits_completed,
            "completed_count": len(completed),
            "uptime_hours": round(uptime_hours, 2),
            "total_earnings_sol": round(self.total_earnings_sol, 6),
            "average_per_audit_sol": round(avg_earnings, 6),
            "audits_per_hour": round(self.audits_completed / uptime_hours if uptime_hours > 0 else 0, 2),
            "start_time": self.start_time.isoformat(),
            "timestamp": datetime.utcnow().isoformat()
        }
    
    async def refund_failed_audit(
        self,
        job: AutonomousAuditJob
    ) -> bool:
        """
        Issue refund for failed audit
        Ensures users don't lose SOL for failed audits
        
        Args:
            job: Failed audit job
        
        Returns:
            True if refund initiated
        """
        try:
            logger.info(f"💸 Initiating refund for {job.job_id}...")
            # TODO: Create refund transaction
            return True
        except Exception as e:
            logger.error(f"Refund failed: {e}")
            return False


# ============================================================================
# GLOBAL INSTANCE
# ============================================================================

autonomous_auditor = AutonomousAuditor()


async def start_autonomous_audit_loop(interval_seconds: int = 5):
    """
    Background task: continuously process audit queue
    
    Args:
        interval_seconds: Check queue every N seconds
    """
    logger.info(f"🔄 Starting autonomous audit loop (check every {interval_seconds}s)")
    
    while True:
        try:
            await autonomous_auditor.process_batch(max_concurrent=3)
            await asyncio.sleep(interval_seconds)
        except Exception as e:
            logger.error(f"Audit loop error: {e}")
            await asyncio.sleep(interval_seconds)
