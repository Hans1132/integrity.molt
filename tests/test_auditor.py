"""
Tests for security_auditor module
"""
import pytest
from unittest.mock import patch, MagicMock
from src.security_auditor import SecurityAuditor, format_audit_report


class TestSecurityAuditor:
    """Test cases for SecurityAuditor class"""
    
    def test_analyze_contract_success(self):
        """Test successful contract analysis"""
        test_address = "EvXNCtaoVuC1NQLQswAnqsbQKPgVTdjrrLKa8MpMJiLf"
        test_code = "// test contract"
        
        # Mock OpenAI response
        mock_response = MagicMock()
        mock_response.choices[0].message.content = "✅ No critical issues found"
        mock_response.usage.total_tokens = 150
        
        with patch('src.security_auditor.client.chat.completions.create', return_value=mock_response):
            result = SecurityAuditor.analyze_contract(test_address, test_code)
        
        assert result["status"] == "success"
        assert result["contract_address"] == test_address
        assert "No critical issues" in result["findings"]
        assert result["tokens_used"] == 150
    
    def test_analyze_contract_error(self):
        """Test error handling in contract analysis"""
        test_address = "invalid_address"
        
        with patch('src.security_auditor.client.chat.completions.create', side_effect=Exception("API error")):
            result = SecurityAuditor.analyze_contract(test_address)
        
        assert result["status"] == "error"
        assert "API error" in result["error"]
    
    def test_format_audit_report_success(self):
        """Test formatting successful audit report"""
        audit_result = {
            "status": "success",
            "contract_address": "EvXNCtaoVuC1NQLQswAnqsbQKPgVTdjrrLKa8MpMJiLf",
            "findings": "Sample findings"
        }
        
        formatted = format_audit_report(audit_result)
        
        assert "EvXNCtaoVuC1NQLQswAnqsbQKPgVTdjrrLKa8..." in formatted
        assert "Sample findings" in formatted
    
    def test_format_audit_report_error(self):
        """Test formatting error audit report"""
        audit_result = {
            "status": "error",
            "error": "Test error message"
        }
        
        formatted = format_audit_report(audit_result)
        
        assert "❌" in formatted
        assert "Test error message" in formatted


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
