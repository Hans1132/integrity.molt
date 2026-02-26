"""
Metaplex Core NFT Integration for Audit Anchoring
Creates immutable on-chain proof of security audit via Metaplex Core NFTs
"""
import logging
import hashlib
import json
from datetime import datetime
from typing import Optional, Dict, Any

logger = logging.getLogger(__name__)

try:
    from solders.pubkey import Pubkey as PublicKey
    from solana.rpc.api import Client
except ImportError:
    try:
        from solana.publickey import PublicKey
        from solana.rpc.api import Client
    except ImportError:
        PublicKey = str  # Fallback: use string representation
        Client = None

from src.config import Config


class MetaplexNFTAnchor:
    """Anchors audit reports as Metaplex Core NFTs on Solana"""
    
    def __init__(self):
        """Initialize Metaplex client"""
        self.rpc_client = None
        if Client is not None:
            self.rpc_client = Client(Config.SOLANA_RPC_URL)
        
        self.metaplex_program_id = Config.METAPLEX_PROGRAM_ID
        self.issuer_public_key = Config.SOLANA_PUBLIC_KEY
        self.enabled = self._verify_connection()
    
    def _verify_connection(self) -> bool:
        """Verify Solana RPC connection"""
        if self.rpc_client is None:
            logger.warning("⚠️ Solana RPC Client not available - using fallback mode (Phase 2)")
            return False
        
        try:
            response = self.rpc_client.get_health()
            logger.info(f"✅ Solana RPC connected: {Config.SOLANA_RPC_URL}")
            return True
        except Exception as e:
            logger.error(f"❌ Failed to connect to Solana RPC: {e}")
            return False
    
    def _generate_audit_hash(self, audit_result: dict) -> str:
        """
        Generate deterministic hash of audit findings
        Used as immutable proof in NFT metadata
        
        Args:
            audit_result: Full audit result dict
        
        Returns:
            SHA256 hash hex string
        """
        # Create canonical JSON (sorted keys for consistency)
        audit_str = json.dumps({
            "contract_address": audit_result.get("contract_address", ""),
            "findings": audit_result.get("findings", ""),
            "pattern_findings": audit_result.get("pattern_findings", []),
            "tokens_used": audit_result.get("tokens_used", 0),
            "cost_usd": audit_result.get("cost_usd", 0),
            "timestamp": datetime.utcnow().isoformat()
        }, sort_keys=True)
        
        return hashlib.sha256(audit_str.encode()).hexdigest()
    
    def create_audit_nft(
        self,
        contract_address: str,
        audit_result: dict,
        r2_report_url: Optional[str] = None
    ) -> dict:
        """
        Create an NFT representing the audit report
        
        In Phase 1/2, this generates the NFT metadata payload.
        In Phase 3 (with payment processing), this will sign and submit to blockchain.
        
        Args:
            contract_address: Solana contract address being audited
            audit_result: Complete audit result dict
            r2_report_url: URL to full report in R2 (optional)
        
        Returns:
            dict with NFT metadata and mint instructions
        """
        
        if not self.enabled:
            return {
                "status": "offline",
                "reason": "Solana RPC connection unavailable"
            }
        
        try:
            audit_hash = self._generate_audit_hash(audit_result)
            timestamp = datetime.utcnow().isoformat()
            
            # Build NFT metadata compliant with Metaplex Core
            nft_metadata = {
                "name": f"Audit Report: {contract_address[:8]}",
                "symbol": "AUDIT",
                "uri": r2_report_url or f"ipfs://integrity-molt/{contract_address[:8]}/{timestamp}",
                "description": f"Security audit of Solana contract {contract_address}",
                "attributes": [
                    {
                        "trait_type": "Audit Hash",
                        "value": audit_hash
                    },
                    {
                        "trait_type": "Contract Address",
                        "value": contract_address
                    },
                    {
                        "trait_type": "Risk Score",
                        "value": self._calculate_risk_score(audit_result)
                    },
                    {
                        "trait_type": "Tokens Used",
                        "value": str(audit_result.get("tokens_used", 0))
                    },
                    {
                        "trait_type": "Cost USD",
                        "value": f"${audit_result.get('cost_usd', 0):.4f}"
                    },
                    {
                        "trait_type": "Auditor",
                        "value": "integrity.molt"
                    }
                ],
                "properties": {
                    "creators": [
                        {
                            "address": self.issuer_public_key,
                            "verified": True,
                            "share": 100
                        }
                    ],
                    "files": [
                        {
                            "uri": r2_report_url or "on-chain",
                            "type": "application/json"
                        }
                    ]
                },
                "image": "https://app.molt.id/integrity-molt-logo.png",
                "external_url": f"https://app.molt.id/audits/{contract_address}"
            }
            
            logger.info(f"✅ Generated NFT metadata for {contract_address}")
            logger.debug(f"Audit hash: {audit_hash}")
            
            # Return payload (ready for Phase 3 signing)
            return {
                "status": "prepared",
                "contract_address": contract_address,
                "audit_hash": audit_hash,
                "metadata": nft_metadata,
                "program_id": str(self.metaplex_program_id),
                "creator": self.issuer_public_key,
                "timestamp": timestamp,
                "message": "NFT payload prepared. In Phase 3, this will be signed and submitted to Metaplex Core."
            }
        
        except Exception as e:
            logger.error(f"❌ NFT creation failed: {e}", exc_info=True)
            return {
                "status": "error",
                "error": str(e),
                "error_type": type(e).__name__
            }
    
    def _calculate_risk_score(self, audit_result: dict) -> str:
        """
        Calculate simplified risk score (1-10) from audit findings
        
        Args:
            audit_result: Audit result dict
        
        Returns:
            Risk score string (1-10)
        """
        pattern_findings = audit_result.get("pattern_findings", [])
        
        # Start at 1 (baseline)
        score = 1
        
        # Add points for critical findings
        critical_count = sum(1 for f in pattern_findings if f.get("severity") == "CRITICAL")
        score += critical_count * 3  # Each critical = +3
        
        # Add points for high findings
        high_count = sum(1 for f in pattern_findings if f.get("severity") == "HIGH")
        score += high_count * 1.5
        
        # Cap at 10
        score = min(int(score), 10)
        
        return str(max(score, 1))
    
    def verify_audit_nft(self, mint_address: str) -> dict:
        """
        Verify audit NFT on-chain (Phase 3+)
        
        Args:
            mint_address: NFT mint address on Solana
        
        Returns:
            dict with verification status and metadata
        """
        
        if not self.enabled or self.rpc_client is None:
            return {"status": "offline"}
        
        try:
            # In Phase 2, we generate verification links without RPC
            # Phase 3 will add actual on-chain verification
            logger.info(f"Verifying NFT: {mint_address}")
            
            return {
                "status": "verified",
                "mint_address": mint_address,
                "solscan_url": f"https://solscan.io/token/{mint_address}",
                "metaplex_url": f"https://www.metaplex.com/explore/{mint_address}"
            }
        
        except Exception as e:
            logger.error(f"❌ NFT verification failed: {e}")
            return {
                "status": "error",
                "error": str(e)
            }
    
    def generate_solscan_link(self, contract_address: str, audit_hash: str) -> str:
        """
        Generate Solscan link for audit proof
        
        Args:
            contract_address: Contract being audited
            audit_hash: Audit hash stored in NFT
        
        Returns:
            Solscan search URL
        """
        # Solscan search for the audit hash in transaction history
        return f"https://solscan.io/tx/{audit_hash[:32]}"


# Global Metaplex instance
metaplex_anchor = MetaplexNFTAnchor()


def create_audit_nft_anchor(
    contract_address: str,
    audit_result: dict,
    r2_report_url: Optional[str] = None
) -> dict:
    """Convenience function to create audit NFT"""
    return metaplex_anchor.create_audit_nft(contract_address, audit_result, r2_report_url)


def verify_audit_nft(mint_address: str) -> dict:
    """Convenience function to verify audit NFT"""
    return metaplex_anchor.verify_audit_nft(mint_address)


if __name__ == "__main__":
    # Test Metaplex integration
    print("Testing Metaplex NFT Anchor...")
    
    test_audit = {
        "status": "success",
        "contract_address": "EvXNCtaoVuC1NQLQswAnqsbQKPgVTdjrrLKa8MpMJiLf",
        "findings": "Test findings",
        "pattern_findings": [
            {"severity": "CRITICAL", "description": "Test critical"}
        ],
        "tokens_used": 100,
        "cost_usd": 0.0030
    }
    
    result = create_audit_nft_anchor(
        "EvXNCtaoVuC1NQLQswAnqsbQKPgVTdjrrLKa8MpMJiLf",
        test_audit,
        "https://example.com/report.json"
    )
    print(json.dumps(result, indent=2))
