"""
Free Tier Security Analyzer
Pattern-based vulnerability detection for free users
No API costs - uses local regex patterns and heuristics
"""
import logging
import re
from typing import Dict, Any, List

logger = logging.getLogger(__name__)


class FreeSecurityAnalyzer:
    """
    Free-tier security analyzer using pattern detection only
    No API calls - zero cost
    """
    
    # Vulnerability patterns (same as VulnerabilityDetector)
    PATTERNS = {
        "reentrancy": {
            "severity": "CRITICAL",
            "regex": r"(call|transfer).*\.value|\.send\(|selfdestruct",
            "description": "Potential reentrancy vulnerability - unsafe external call",
            "remediation": "Use checks-effects-interactions pattern or reentrancy guards"
        },
        "unchecked_call": {
            "severity": "CRITICAL",
            "regex": r"call\(|callCode\(|delegatecall\(",
            "description": "Unchecked external call may fail silently",
            "remediation": "Check return value: require(success, 'Call failed')"
        },
        "delegatecall": {
            "severity": "CRITICAL",
            "regex": r"delegatecall\(",
            "description": "Unsafe delegatecall - can change contract state",
            "remediation": "Verify context carefully, use proxy pattern cautiously"
        },
        "overflow": {
            "severity": "HIGH",
            "regex": r"(\+\+|--|\+=|-=)(?!.*SafeMath)",
            "description": "Potential integer overflow/underflow",
            "remediation": "Use SafeMath library or Solidity 0.8+ checked arithmetic"
        },
        "access_control": {
            "severity": "CRITICAL",
            "regex": r"(function|modifier).*(?!public|private|internal|external)|onlyOwner.*modifier",
            "description": "Missing or weak access control",
            "remediation": "Add proper access modifiers and role-based checks"
        },
        "selfdestruct": {
            "severity": "HIGH",
            "regex": r"selfdestruct\(",
            "description": "Contract can be destroyed - potential security issue",
            "remediation": "Restrict selfdestruct to authorized parties only"
        },
        "hardcoded_state": {
            "severity": "MEDIUM",
            "regex": r"=\s*0x[0-9a-fA-F]+;|=\s*[0-9]+;",
            "description": "Hardcoded values in contract state",
            "remediation": "Use constructor parameters or configuration contracts"
        },
        "missing_validation": {
            "severity": "MEDIUM",
            "regex": r"require\(|assert\(|if\(",
            "description": "Input validation patterns detected",
            "remediation": "Ensure all user inputs are validated"
        }
    }
    
    # Risk score calculation
    RISK_WEIGHTS = {
        "CRITICAL": 3,
        "HIGH": 2,
        "MEDIUM": 1,
        "LOW": 0.5
    }
    
    def __init__(self):
        """Initialize free analyzer"""
        logger.info("✅ Free Security Analyzer initialized (pattern-based, zero-cost)")
    
    def analyze_contract(
        self,
        contract_code: str
    ) -> Dict[str, Any]:
        """
        Analyze contract using patterns only (no API)
        
        Args:
            contract_code: Contract source or bytecode
        
        Returns:
            Analysis results
        """
        try:
            logger.info(f"🔍 Analyzing contract (free tier - patterns only)")
            
            # Detect patterns
            findings = self._detect_patterns(contract_code)
            
            # Calculate risk score
            risk_score = self._calculate_risk_score(findings)
            
            # Generate findings report
            findings_text = self._generate_findings_report(findings, risk_score)
            
            result = {
                "status": "success",
                "analysis_type": "free_tier_pattern_based",
                "findings": findings_text,
                "pattern_findings": findings,
                "risk_score": risk_score,
                "tokens_used": 0,  # No API calls
                "cost_usd": 0.0,   # Free
                "disclaimer": "Free-tier analysis uses pattern detection only. Paid audits include full GPT-4 analysis for deeper security review."
            }
            
            logger.info(
                f"✅ Pattern analysis complete | "
                f"Risk: {risk_score}/10 | "
                f"Patterns found: {len(findings)}"
            )
            
            return result
        
        except Exception as e:
            logger.error(f"❌ Analysis failed: {e}")
            return {
                "status": "error",
                "error": str(e),
                "error_type": type(e).__name__
            }
    
    def _detect_patterns(self, code: str) -> List[Dict[str, Any]]:
        """
        Detect vulnerability patterns in code
        
        Args:
            code: Contract code
        
        Returns:
            List of detected vulnerabilities
        """
        findings = []
        
        for pattern_name, pattern_info in self.PATTERNS.items():
            try:
                matches = re.findall(
                    pattern_info["regex"],
                    code,
                    re.IGNORECASE | re.MULTILINE
                )
                
                if matches:
                    finding = {
                        "name": pattern_name,
                        "severity": pattern_info["severity"],
                        "description": pattern_info["description"],
                        "remediation": pattern_info["remediation"],
                        "match_count": len(matches),
                        "detected": True
                    }
                    findings.append(finding)
                    
                    logger.debug(f"  Found: {pattern_name} ({len(matches)} matches)")
            
            except Exception as e:
                logger.warning(f"  Pattern '{pattern_name}' check failed: {e}")
        
        return findings
    
    def _calculate_risk_score(self, findings: List[Dict[str, Any]]) -> int:
        """
        Calculate risk score (1-10) from findings
        
        Args:
            findings: List of vulnerability findings
        
        Returns:
            Risk score 1-10
        """
        if not findings:
            return 1  # Minimal risk
        
        # Sum weights
        total_weight = 0
        critical_count = 0
        
        for finding in findings:
            severity = finding.get("severity", "LOW")
            weight = self.RISK_WEIGHTS.get(severity, 0)
            count = finding.get("match_count", 1)
            
            total_weight += weight * count
            
            if severity == "CRITICAL":
                critical_count += count
        
        # Map weight to 1-10 scale
        risk_score = min(10, max(1, int(total_weight)))
        
        # Boost score for critical issues
        if critical_count > 0:
            risk_score = max(risk_score, 6)  # At least 6 if critical found
        
        return risk_score
    
    def _generate_findings_report(
        self,
        findings: List[Dict[str, Any]],
        risk_score: int
    ) -> str:
        """
        Generate text report of findings
        
        Args:
            findings: List of vulnerabilities
            risk_score: Calculated risk score
        
        Returns:
            Formatted findings report
        """
        if not findings:
            return (
                "✅ **No Critical Vulnerabilities Detected**\n\n"
                "Pattern analysis found no obvious security issues.\n\n"
                "📌 **Note**: This is a pattern-based analysis using heuristics.\n"
                "For comprehensive security review, upgrade to paid tier with full GPT-4 analysis.\n\n"
                "**Recommendations**:\n"
                "1. Use SafeMath for arithmetic operations\n"
                "2. Implement access controls\n"
                "3. Use reentrancy guards\n"
                "4. Validate all inputs\n"
                "5. Follow security best practices"
            )
        
        report = f"⚠️ **Security Analysis Report** (Risk: {risk_score}/10)\n\n"
        report += "**📊 Pattern-Based Findings**:\n\n"
        
        # Group by severity
        by_severity = {}
        for finding in findings:
            severity = finding["severity"]
            if severity not in by_severity:
                by_severity[severity] = []
            by_severity[severity].append(finding)
        
        # Output by severity (critical first)
        severity_order = ["CRITICAL", "HIGH", "MEDIUM", "LOW"]
        
        for severity in severity_order:
            if severity in by_severity:
                emoji = {"CRITICAL": "🔴", "HIGH": "🟠", "MEDIUM": "🟨", "LOW": "🟩"}[severity]
                report += f"{emoji} **{severity} Issues** ({len(by_severity[severity])}):\n\n"
                
                for finding in by_severity[severity]:
                    report += f"**• {finding['name'].replace('_', ' ').title()}**\n"
                    report += f"  Description: {finding['description']}\n"
                    report += f"  Remediation: {finding['remediation']}\n"
                    report += f"  Found: {finding['match_count']} time(s)\n\n"
        
        report += "💡 **Free Tier Benefits**:\n"
        report += "✅ Instant pattern-based analysis\n"
        report += "✅ Zero API costs\n"
        report += "✅ Quick vulnerability detection\n"
        report += "✅ Best practices recommendations\n\n"
        
        report += "⭐ **Upgrade to Paid Tier for**:\n"
        report += "✅ Full GPT-4 security analysis\n"
        report += "✅ Deeper code understanding\n"
        report += "✅ Business logic vulnerabilities\n"
        report += "✅ Advanced attack vectors\n"
        report += "✅ Custom remediation advice\n\n"
        
        report += "Use `/subscribe` to unlock premium analysis!"
        
        return report


# Global instance
free_analyzer = FreeSecurityAnalyzer()


if __name__ == "__main__":
    # Test free analyzer
    print("Testing Free Security Analyzer...")
    print("=" * 50)
    
    test_code = """
    function withdraw() public {
        uint balance = balances[msg.sender];
        (bool success, ) = msg.sender.call{value: balance}("");
        balances[msg.sender] = 0;
    }
    """
    
    result = free_analyzer.analyze_contract(test_code)
    print(f"\nAnalysis Type: {result['analysis_type']}")
    print(f"Risk Score: {result['risk_score']}/10")
    print(f"Cost: ${result['cost_usd']}")
    print(f"Findings:\n{result['findings']}")
    
    print("\n✅ Free analyzer test complete!")
