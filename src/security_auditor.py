"""
Security Auditor module
Uses GPT-4 to analyze smart contracts for vulnerabilities
Enhanced with pattern-based detection and comprehensive vulnerability analysis
Stores audit reports in Cloudflare R2
Anchors audits as Metaplex Core NFTs on Solana
"""
import logging
import re
from openai import OpenAI
from src.config import Config
from src.r2_storage import upload_audit_to_r2
from src.metaplex_nft import create_audit_nft_anchor

logger = logging.getLogger(__name__)
client = OpenAI(api_key=Config.OPENAI_API_KEY)


class VulnerabilityDetector:
    """Pattern-based local vulnerability detection (before GPT-4 call)"""
    
    PATTERNS = {
        "reentrancy": {
            "pattern": r"(call|transfer).*\(.*\).*state.*change|state.*change.*(call|transfer)",
            "severity": "CRITICAL",
            "description": "Potential reentrancy vulnerability: external call before state update"
        },
        "unchecked_call": {
            "pattern": r"(call|send|transfer).*\(\)|\.call\{.*\}\(.*\)",
            "severity": "HIGH",
            "description": "Unchecked external call may silently fail"
        },
        "delegatecall": {
            "pattern": r"delegatecall|DELEGATECALL",
            "severity": "CRITICAL",
            "description": "Dangerous delegatecall usage - verify contract address validation"
        },
        "overflow": {
            "pattern": r"\+\+|\-\-|\.add|\.sub|\.mul|\.div(?!ide)|unchecked\s*{",
            "severity": "HIGH",
            "description": "Arithmetic operation - check for overflow/underflow protection"
        },
        "access_control": {
            "pattern": r"tx\.origin|msg\.sender|onlyOwner|onlyAdmin|require\([a-zA-Z_]+ ==",
            "severity": "MEDIUM",
            "description": "Access control check found - verify authorization is correct"
        },
        "selfdestruct": {
            "pattern": r"selfdestruct|SELFDESTRUCT",
            "severity": "HIGH",
            "description": "Selfdestruct usage found - potential irreversible action"
        },
        "hardcoded_state": {
            "pattern": r"=\s*['\"]0x[a-fA-F0-9]{40}['\"]|=\s*\d+",
            "severity": "LOW",
            "description": "Hardcoded values detected - consider using constants or configuration"
        }
    }
    
    @staticmethod
    def detect_patterns(code: str) -> list:
        """
        Detect vulnerability patterns in code using regex
        
        Args:
            code: Contract source code or bytecode
            
        Returns:
            List of detected pattern matches with severity
        """
        findings = []
        
        for vuln_type, pattern_info in VulnerabilityDetector.PATTERNS.items():
            try:
                if re.search(pattern_info["pattern"], code, re.IGNORECASE):
                    findings.append({
                        "type": vuln_type,
                        "severity": pattern_info["severity"],
                        "description": pattern_info["description"]
                    })
            except Exception as e:
                logger.debug(f"Pattern {vuln_type} check failed: {e}")
        
        return findings


class SecurityAuditor:
    """AI-powered contract security analyzer with enhanced vulnerability detection"""
    
    # Structured prompts for specific vulnerability types
    CRITICAL_VULNS_PROMPT = """
    Focus on CRITICAL vulnerabilities that could lead to fund loss:
    1. Reentrancy attacks (external call before state update)
    2. Delegatecall vulnerabilities (untrusted contract execution)
    3. Unchecked send/call/transfer (silent failures)
    4. Integer overflow/underflow (arithmetic without SafeMath)
    5. Access control bypass (incorrect auth checks)
    
    Contract: {code}
    
    List any critical issues found with specific line references if available.
    """
    
    MEDIUM_VULNS_PROMPT = """
    Check for MEDIUM severity issues:
    1. Front-running vulnerabilities (transaction ordering)
    2. Timestamp dependence (block.timestamp manipulation)
    3. Tx.origin usage (incorrect access control)
    4. SelfDestruct keying (premature contract termination)
    5. Race conditions (concurrent state changes)
    6. Unused variables or dead code
    
    Contract: {code}
    
    Identify any medium-risk patterns.
    """
    
    LOW_RISK_PROMPT = """
    Review for LOW severity findings:
    1. Code quality issues (naming, comments, structure)
    2. Gas optimization opportunities
    3. Event logging (missing or incomplete)
    4. Hardcoded addresses or values
    5. Function visibility (could be more restrictive)
    6. Best practice deviations (style, patterns)
    
    Contract: {code}
    
    Suggest low-priority improvements.
    """
    
    SECURITY_PROMPT_TEMPLATE = """
    You are a professional smart contract security auditor with 10+ years experience auditing Solana and EVM contracts.
    
    Contract Address: {address}
    Contract Code/Bytecode:
    {code}
    
    Provide a comprehensive structured security audit covering:
    
    1. **CRITICAL Issues** (High-Impact Vulnerabilities):
       - Reentrancy attacks
       - Unsafe delegatecall
       - Integer overflow/underflow
       - Unchecked external calls
       - Critical access control flaws
    
    2. **HIGH Issues** (Moderate-Impact):
       - Front-running vulnerabilities
       - Timestamp dependencies
       - Incorrect authorization
       - Logic errors in state transitions
    
    3. **MEDIUM Issues** (Need Attention):
       - Gas optimization
       - Code quality
       - Missing validations
       - Event logging gaps
    
    4. **Risk Score**: 1-10 (10 = critical, do not deploy)
    
    5. **Remediation Steps**: Specific fixes for each issue
    
    Format output with clear sections and severity levels.
    """
    
    
    @staticmethod
    def analyze_contract(
        contract_address: str,
        contract_code: str = ""
    ) -> dict:
        """
        Analyze a smart contract using GPT-4 with pattern-based pre-detection
        
        Args:
            contract_address: Solana contract address
            contract_code: Contract source code or bytecode
        
        Returns:
            dict with keys:
            - status: "success" or "error"
            - findings: Security audit findings (structured)
            - pattern_findings: Pre-detected vulnerability patterns
            - risk_score: 1-10
            - tokens_used: GPT-4 token count
            - cost_usd: Estimated cost
        """
        try:
            logger.info(f"Starting enhanced audit for {contract_address}")
            
            # If no code provided, return placeholder
            if not contract_code:
                contract_code = f"[Contract bytecode from Solana: {contract_address}]"
            
            # **STAGE 1: Pattern-based local detection** (free, instant)
            pattern_findings = VulnerabilityDetector.detect_patterns(contract_code)
            logger.debug(f"Pattern detection found {len(pattern_findings)} potential issues")
            
            # Truncate code if too large (keep tokens/cost low)
            original_size = len(contract_code)
            if len(contract_code) > Config.MAX_AUDIT_SIZE_BYTES:
                logger.warning(f"Contract code too large ({original_size} bytes), truncating to {Config.MAX_AUDIT_SIZE_BYTES} bytes")
                contract_code = contract_code[:Config.MAX_AUDIT_SIZE_BYTES] + "\n[... code truncated]"
            
            # **STAGE 2: Create enhanced prompt based on pattern findings**
            # Add detected patterns to context for GPT-4
            pattern_context = ""
            if pattern_findings:
                pattern_context = "\n\n⚠️ Pre-analysis detected these patterns:\n"
                for finding in pattern_findings:
                    pattern_context += f"- {finding['severity']}: {finding['description']}\n"
                pattern_context += "\nPlease verify and expand on these in your analysis.\n"
            
            # Create enhanced audit prompt
            prompt = SecurityAuditor.SECURITY_PROMPT_TEMPLATE.format(
                address=contract_address,
                code=contract_code
            ) + pattern_context
            
            # **STAGE 3: Call GPT-4 with enhanced context**
            logger.info(f"Calling GPT-4 for contract analysis (code size: {len(contract_code)} bytes)")
            response = client.chat.completions.create(
                model=Config.GPT4_MODEL,
                messages=[
                    {
                        "role": "system",
                        "content": "You are an expert smart contract security auditor with deep knowledge of Solana and EVM vulnerabilities. "
                                   "Provide actionable, detailed security recommendations. Always be skeptical and thorough."
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
            
            # Calculate cost (GPT-4 Turbo pricing)
            cost_usd = (tokens_used / 1000) * 0.03
            
            # Log detailed cost info
            logger.info(
                f"Audit completed for {contract_address} | "
                f"Tokens: {tokens_used} | Cost: ${cost_usd:.4f} | "
                f"Pattern findings: {len(pattern_findings)}"
            )
            
            # Prepare audit result
            audit_result = {
                "status": "success",
                "contract_address": contract_address,
                "findings": findings,
                "pattern_findings": pattern_findings,
                "tokens_used": tokens_used,
                "cost_usd": cost_usd,
                "code_size_bytes": original_size
            }
            
            # **STAGE 4: Upload to R2 Storage** (optional, async-friendly)
            r2_upload = upload_audit_to_r2(contract_address, audit_result, findings)
            audit_result["r2_storage"] = r2_upload
            
            if r2_upload.get("status") == "success":
                logger.info(f"✅ Audit stored in R2: {r2_upload.get('report_url')}")
            
            # **STAGE 5: Anchor to Metaplex Core NFT** (on-chain proof)
            r2_report_url = r2_upload.get("report_url") if r2_upload.get("status") == "success" else None
            nft_result = create_audit_nft_anchor(contract_address, audit_result, r2_report_url)
            audit_result["nft_anchor"] = nft_result
            
            if nft_result.get("status") == "prepared":
                logger.info(
                    f"✅ NFT anchor prepared | "
                    f"Hash: {nft_result.get('audit_hash')[:16]}... | "
                    f"Solscan: https://solscan.io/token/{contract_address[:8]}"
                )
            
            return audit_result
        
        except Exception as e:
            logger.error(f"Audit failed for {contract_address}: {str(e)}", exc_info=True)
            return {
                "status": "error",
                "contract_address": contract_address,
                "error": str(e),
                "error_type": type(e).__name__
            }


def format_audit_report(audit_result: dict) -> str:
    """
    Format audit result for Telegram display with pattern findings
    
    Args:
        audit_result: Output from analyze_contract()
    
    Returns:
        Formatted string for Telegram message (with emoji highlights)
    """
    if audit_result["status"] == "error":
        return f"❌ **Audit Failed**: {audit_result.get('error', 'Unknown error')}"
    
    addr_short = audit_result["contract_address"][:8]
    addr_preview = audit_result["contract_address"][:37]
    findings = audit_result["findings"]
    pattern_findings = audit_result.get("pattern_findings", [])
    code_size = audit_result.get("code_size_bytes", 0)
    
    # Build report with pattern findings highlighted
    report = f"📋 **Security Audit Report for {addr_preview}...** ({addr_short}...)\n\n"
    
    if pattern_findings:
        report += "⚠️ **Pre-Analysis Detections**:\n"
        critical_count = sum(1 for f in pattern_findings if f["severity"] == "CRITICAL")
        high_count = sum(1 for f in pattern_findings if f["severity"] == "HIGH")
        
        if critical_count > 0:
            report += f"🔴 {critical_count} CRITICAL pattern(s) detected\n"
        if high_count > 0:
            report += f"🟠 {high_count} HIGH pattern(s) detected\n"
        report += "\n"
    
    # Add GPT-4 detailed findings
    report += "**Detailed Analysis**:\n"
    report += findings
    
    # Footer with metadata
    report += f"\n\n---\n"
    report += f"📊 Code size: {code_size:,} bytes | "
    report += f"Tokens: {audit_result.get('tokens_used', 0)} | "
    report += f"Cost: ${audit_result.get('cost_usd', 0):.4f}"
    
    # Add R2 storage link if available
    r2_info = audit_result.get("r2_storage", {})
    if r2_info.get("status") == "success":
        r2_url = r2_info.get("report_url", "")
        report += f"\n\n🔗 [Full Report on R2]({r2_url})"
    elif r2_info.get("status") == "error":
        report += f"\n\n⚠️ Full report storage failed (R2 error)"
    
    # Add NFT anchor if available
    nft_info = audit_result.get("nft_anchor", {})
    if nft_info.get("status") == "prepared":
        audit_hash = nft_info.get("audit_hash", "")[:16]
        report += f"\n🔐 **On-Chain NFT Proof** (Phase 3): Audit hash {audit_hash}... ready for Metaplex Core"
    elif nft_info.get("status") == "offline":
        report += f"\n⚠️ On-chain anchoring offline (Solana RPC unavailable)"
    
    return report


if __name__ == "__main__":
    # Test audit (requires OPENAI_API_KEY in .env)
    test_address = "EvXNCtaoVuC1NQLQswAnqsbQKPgVTdjrrLKa8MpMJiLf"
    test_code = "// Placeholder contract code"
    
    print(f"Testing audit for {test_address}...")
    result = SecurityAuditor.analyze_contract(test_address, test_code)
    print(result)
