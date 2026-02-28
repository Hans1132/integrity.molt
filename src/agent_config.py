"""
Agent Configuration & Identity Verification
On-chain identity for integrity.molt Agent on Moltbook
"""
import os
import json
import logging
import hashlib
import hmac
from datetime import datetime, timedelta
from typing import Dict, Optional
import jwt

logger = logging.getLogger(__name__)


class AgentConfig:
    """
    On-chain agent configuration with Moltbook integration
    Provides identity verification for all audits posted on-chain
    """
    
    # Agent On-Chain Identity (Moltbook)
    AGENT_WALLET = "BFmkPKu2tS9RoMufgJUd9GyabzC91hriAbMS6Hmr8TX6"
    IDENTITY_NFT = "2tWPw22bqgLaLdYCwe7599f7guQudwKpCCta4gvhgZZy"
    IDENTITY_NAME = "integrity.molt"
    
    # Moltbook API Configuration
    MOLTBOOK_API_URL = os.getenv("MOLTBOOK_API_URL", "https://api.molt.id")
    MOLTBOOK_AGENT_ID = os.getenv("MOLTBOOK_AGENT_ID", "molt_78587c41ed99a3375022dc28")
    MOLTBOOK_DOMAIN_NAME = os.getenv("MOLTBOOK_DOMAIN_NAME", "integrity.molt")
    
    # Agent Credentials (from environment)
    AGENT_PRIVATE_KEY = os.getenv("AGENT_PRIVATE_KEY", "")  # Base58 encoded
    MOLTBOOK_API_KEY = os.getenv("MOLTBOOK_API_KEY", "")
    
    # Verification Parameters
    TOKEN_EXPIRY_HOURS = 24
    VERIFICATION_SCHEME = "JWT-Ed25519"
    
    @staticmethod
    def get_agent_header() -> Dict[str, str]:
        """
        Get agent headers for Moltbook API requests
        Includes agent identity and verification token
        """
        return {
            "X-Agent-Identity": AgentConfig.AGENT_WALLET,
            "X-Agent-NFT": AgentConfig.IDENTITY_NFT,
            "X-Agent-Name": AgentConfig.IDENTITY_NAME,
            "X-Agent-Domain": AgentConfig.MOLTBOOK_DOMAIN_NAME,
        }
    
    @staticmethod
    def get_identity_header() -> Dict[str, str]:
        """
        Generate authentication headers with signed JWT token
        
        Each audit post will be marked as:
        'Officially Verified by integrity.molt'
        
        Returns:
            dict: Headers including JWT authentication token
            
        Raises:
            ValueError: If private key not configured
        """
        if not AgentConfig.AGENT_PRIVATE_KEY:
            logger.error("❌ AGENT_PRIVATE_KEY not configured in environment")
            raise ValueError("Agent private key required for identity verification")
        
        try:
            # Create JWT payload
            now = datetime.utcnow()
            payload = {
                # Standard JWT claims
                "iss": AgentConfig.AGENT_WALLET,  # Issuer = agent wallet
                "sub": AgentConfig.IDENTITY_NFT,  # Subject = identity NFT
                "aud": "moltbook-api",  # Audience
                "iat": int(now.timestamp()),  # Issued at
                "exp": int((now + timedelta(hours=AgentConfig.TOKEN_EXPIRY_HOURS)).timestamp()),  # Expiry
                
                # Agent-specific claims
                "agent_id": AgentConfig.MOLTBOOK_AGENT_ID,
                "agent_name": AgentConfig.IDENTITY_NAME,
                "agent_domain": AgentConfig.MOLTBOOK_DOMAIN_NAME,
                "verification_scheme": AgentConfig.VERIFICATION_SCHEME,
                
                # Verification message
                "verification_message": f"Officially Verified by {AgentConfig.IDENTITY_NAME}",
                "nonce": hashlib.sha256(
                    f"{now.isoformat()}{AgentConfig.AGENT_WALLET}".encode()
                ).hexdigest()[:16],
            }
            
            # Sign JWT with private key
            # Note: Using HS256 for simplicity; Production should use Ed25519
            token = jwt.encode(
                payload,
                AgentConfig.AGENT_PRIVATE_KEY,
                algorithm="HS256",
                headers={
                    "kid": AgentConfig.AGENT_WALLET,
                    "typ": "JWT",
                }
            )
            
            logger.info(f"✅ Identity token generated for {AgentConfig.IDENTITY_NAME}")
            
            return {
                "Authorization": f"Bearer {token}",
                "X-Agent-Identity": AgentConfig.AGENT_WALLET,
                "X-Agent-NFT": AgentConfig.IDENTITY_NFT,
                "X-Agent-Name": AgentConfig.IDENTITY_NAME,
                "X-Verification-Message": f"Officially Verified by {AgentConfig.IDENTITY_NAME}",
                "X-Verification-Scheme": AgentConfig.VERIFICATION_SCHEME,
            }
            
        except Exception as e:
            logger.error(f"❌ Failed to generate identity header: {e}")
            raise
    
    @staticmethod
    def create_audit_signature(audit_data: Dict) -> str:
        """
        Create HMAC signature for audit data verification
        
        Args:
            audit_data: The audit findings to sign
            
        Returns:
            str: Hex-encoded HMAC signature
        """
        if not AgentConfig.AGENT_PRIVATE_KEY:
            raise ValueError("Agent private key required for audit signature")
        
        # Serialize audit data for signing
        audit_json = json.dumps(audit_data, sort_keys=True)
        
        # Create HMAC-SHA256 signature
        signature = hmac.new(
            AgentConfig.AGENT_PRIVATE_KEY.encode(),
            audit_json.encode(),
            hashlib.sha256
        ).hexdigest()
        
        return signature
    
    @staticmethod
    def verify_audit_signature(audit_data: Dict, signature: str) -> bool:
        """
        Verify audit data signature
        
        Args:
            audit_data: The audit findings
            signature: The signature to verify
            
        Returns:
            bool: True if signature is valid
        """
        expected_signature = AgentConfig.create_audit_signature(audit_data)
        return hmac.compare_digest(signature, expected_signature)
    
    @staticmethod
    def format_verified_audit_post(audit_report: Dict) -> Dict:
        """
        Format audit report for posting on Moltbook with agent verification
        
        Args:
            audit_report: Original audit report from GPT-4
            
        Returns:
            dict: Formatted post with verification metadata
        """
        verified_post = {
            # Original audit data
            "audit_data": audit_report,
            
            # Agent verification
            "agent_verification": {
                "agent_wallet": AgentConfig.AGENT_WALLET,
                "identity_nft": AgentConfig.IDENTITY_NFT,
                "agent_name": AgentConfig.IDENTITY_NAME,
                "verification_timestamp": datetime.utcnow().isoformat(),
                "verification_message": f"Officially Verified by {AgentConfig.IDENTITY_NAME}",
                "verification_scheme": AgentConfig.VERIFICATION_SCHEME,
            },
            
            # Signature for integrity
            "signature": AgentConfig.create_audit_signature(audit_report),
        }
        
        return verified_post
    
    @staticmethod
    def log_agent_config() -> None:
        """Log agent configuration for debugging"""
        logger.info("=" * 60)
        logger.info("🤖 AGENT CONFIGURATION")
        logger.info("=" * 60)
        logger.info(f"Agent Wallet:     {AgentConfig.AGENT_WALLET}")
        logger.info(f"Identity NFT:     {AgentConfig.IDENTITY_NFT}")
        logger.info(f"Agent Name:       {AgentConfig.IDENTITY_NAME}")
        logger.info(f"Moltbook Domain:  {AgentConfig.MOLTBOOK_DOMAIN_NAME}")
        logger.info(f"Moltbook Agent ID:{AgentConfig.MOLTBOOK_AGENT_ID}")
        logger.info(f"API URL:          {AgentConfig.MOLTBOOK_API_URL}")
        logger.info(f"Private Key Set:  {'✅ Yes' if AgentConfig.AGENT_PRIVATE_KEY else '❌ No'}")
        logger.info("=" * 60)


if __name__ == "__main__":
    # Test identity header generation
    logging.basicConfig(level=logging.INFO)
    
    try:
        # Log configuration
        AgentConfig.log_agent_config()
        
        # Test header generation (will fail if no private key)
        if AgentConfig.AGENT_PRIVATE_KEY:
            headers = AgentConfig.get_identity_header()
            logger.info("✅ Identity headers generated successfully")
            logger.info(f"Authorization: {headers['Authorization'][:50]}...")
        else:
            logger.warning("⚠️ Set AGENT_PRIVATE_KEY to test identity generation")
            
    except Exception as e:
        logger.error(f"❌ Error: {e}")
