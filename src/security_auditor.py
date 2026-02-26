"""
Security Auditor module
Uses GPT-4 to analyze smart contracts for vulnerabilities
"""
import logging
from openai import OpenAI
from src.config import Config

logger = logging.getLogger(__name__)
client = OpenAI(api_key=Config.OPENAI_API_KEY)


class SecurityAuditor:
    """AI-powered contract security analyzer"""
    
    SECURITY_PROMPT_TEMPLATE = """
    You are a senior smart contract security auditor. Analyze the following contract code 
    for security vulnerabilities and provide findings.
    
    Contract Address: {address}
    Contract Code:
    {code}
    
    Provide a structured security audit report with:
    1. Critical Issues (if any)
    2. Medium Issues (if any)
    3. Low-Risk Findings (if any)
    4. Overall Risk Score (1-10)
    5. Recommendations
    
    Be concise but thorough.
    """
    
    @staticmethod
    def analyze_contract(
        contract_address: str,
        contract_code: str = ""
    ) -> dict:
        """
        Analyze a smart contract using GPT-4
        
        Args:
            contract_address: Solana contract address
            contract_code: Contract source code or bytecode
        
        Returns:
            dict with keys:
            - status: "success" or "error"
            - findings: Security audit findings
            - risk_score: 1-10
            - tokens_used: GPT-4 token count
        """
        try:
            # Log for cost tracking
            logger.info(f"Starting audit for {contract_address}")
            
            # If no code provided, return placeholder
            if not contract_code:
                contract_code = f"[Contract fetched from Solana: {contract_address}]"
            
            # Truncate code if too large
            if len(contract_code) > Config.MAX_AUDIT_SIZE_BYTES:
                logger.warning(f"Contract code too large, truncating to {Config.MAX_AUDIT_SIZE_BYTES} bytes")
                contract_code = contract_code[:Config.MAX_AUDIT_SIZE_BYTES] + "\n[... truncated]"
            
            # Create audit prompt
            prompt = SecurityAuditor.SECURITY_PROMPT_TEMPLATE.format(
                address=contract_address,
                code=contract_code
            )
            
            # Call GPT-4
            response = client.chat.completions.create(
                model=Config.GPT4_MODEL,
                messages=[
                    {
                        "role": "system",
                        "content": "You are an expert smart contract security auditor."
                    },
                    {
                        "role": "user",
                        "content": prompt
                    }
                ],
                max_tokens=Config.GPT4_MAX_TOKENS,
                temperature=Config.GPT4_TEMPERATURE
            )
            
            findings = response.choices[0].message.content
            tokens_used = response.usage.total_tokens
            
            # Log cost
            cost_usd = (tokens_used / 1000) * 0.03  # Approximate GPT-4 cost
            logger.info(
                f"Audit completed for {contract_address} - "
                f"Tokens: {tokens_used}, Cost: ${cost_usd:.4f}"
            )
            
            return {
                "status": "success",
                "contract_address": contract_address,
                "findings": findings,
                "tokens_used": tokens_used,
                "cost_usd": cost_usd
            }
        
        except Exception as e:
            logger.error(f"Audit failed for {contract_address}: {e}")
            return {
                "status": "error",
                "contract_address": contract_address,
                "error": str(e)
            }


def format_audit_report(audit_result: dict) -> str:
    """
    Format audit result for Telegram display
    
    Args:
        audit_result: Output from analyze_contract()
    
    Returns:
        Formatted string for Telegram message
    """
    if audit_result["status"] == "error":
        return f"❌ Audit failed: {audit_result.get('error', 'Unknown error')}"
    
    findings = audit_result["findings"]
    return f"📋 **Audit Report for {audit_result['contract_address'][:8]}...**\n\n{findings}"


if __name__ == "__main__":
    # Test audit (requires OPENAI_API_KEY in .env)
    test_address = "EvXNCtaoVuC1NQLQswAnqsbQKPgVTdjrrLKa8MpMJiLf"
    test_code = "// Placeholder contract code"
    
    print(f"Testing audit for {test_address}...")
    result = SecurityAuditor.analyze_contract(test_address, test_code)
    print(result)
