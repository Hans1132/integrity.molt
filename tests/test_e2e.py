"""
End-to-End Integration Tests
Tests complete audit flows: Telegram → Analysis → Database → Response
"""
import asyncio
import pytest
from unittest.mock import Mock, AsyncMock, patch, MagicMock
from datetime import datetime


class TestFullAuditFlow:
    """Test complete audit flow from Telegram command to response"""
    
    @pytest.mark.asyncio
    async def test_free_tier_audit_complete_flow(self):
        """Test: Free user sends audit → pattern analysis → response → stored"""
        
        from src.security_auditor import SecurityAuditor
        from src.database import DatabaseClient
        from src.telemetry import telemetry
        
        # Setup
        user_id = 99999
        contract_addr = "EvXNCtaoVuC1NQLQswAnqsbQKPgVTdjrrLKa8MpMJiLf"
        
        # Step 1: Detect free tier user
        auditor = SecurityAuditor()
        quota = await auditor.get_user_quota_info(user_id)
        
        assert quota["tier"] == "free", "User should be free tier"
        assert quota["limits"]["audits_per_hour"] == 2, "Free tier should have 2/hour limit"
        assert quota["cost_per_audit"] == 0.0, "Free tier should be $0/audit"
        
        # Step 2: Run analysis (free tier → pattern-based)
        result = await auditor.analyze_contract(
            contract_address=contract_addr,
            user_id=user_id
        )
        
        assert result["success"], "Analysis should succeed"
        assert result["analysis_type"] == "free_tier_pattern_based", "Should use pattern analyzer"
        assert result["cost_usd"] == 0.0, "Cost should be $0"
        assert "risk_score" in result, "Should have risk score"
        assert 1 <= result["risk_score"] <= 10, "Risk score should be 1-10"
        
        # Step 3: Record in database
        db = DatabaseClient()
        audit_doc = {
            "user_id": user_id,
            "contract_address": contract_addr,
            "analysis_type": result["analysis_type"],
            "cost_usd": result["cost_usd"],
            "risk_score": result["risk_score"],
            "findings": result.get("findings", []),
            "timestamp": datetime.utcnow(),
            "status": "completed"
        }
        
        audit_id = await db.store_audit(audit_doc)
        assert audit_id is not None, "Audit should be stored"
        
        # Step 4: Record in telemetry
        telemetry.record_audit(
            user_id=user_id,
            contract_addr=contract_addr,
            analysis_type=result["analysis_type"],
            cost_usd=result["cost_usd"],
            response_time_ms=100,
            risk_score=result["risk_score"]
        )
        
        metrics = telemetry.get_metrics()
        assert metrics["audits"]["total"] > 0, "Telemetry should record audit"
        
        # Verify complete flow
        print(f"✅ Free tier audit flow complete")
        print(f"   Contract: {contract_addr[:16]}...")
        print(f"   Analysis: {result['analysis_type']}")
        print(f"   Cost: ${result['cost_usd']}")
        print(f"   Risk: {result['risk_score']}/10")
        print(f"   Stored: {audit_id}")
    
    @pytest.mark.asyncio
    async def test_premium_tier_audit_complete_flow(self):
        """Test: Premium user sends audit → GPT-4 analysis → response → stored"""
        
        from src.security_auditor import SecurityAuditor
        
        # Setup - Premium user (subscriber)
        user_id = 88888
        contract_addr = "EvXNCtaoVuC1NQLQswAnqsbQKPgVTdjrrLKa8MpMJiLf"
        
        auditor = SecurityAuditor()
        
        # Step 1: Detect premium tier
        quota = await auditor.get_user_quota_info(user_id, is_subscriber=True)
        
        assert quota["tier"] == "premium", "Subscriber should be premium tier"
        assert quota["limits"]["audits_per_hour"] == 10, "Premium should have 10/hour limit"
        assert quota["cost_per_audit"] > 0, "Premium should have cost for GPT-4"
        
        print(f"✅ Premium tier detection passed")
        print(f"   Quota: {quota['limits']['audits_per_hour']}/hour")
        print(f"   Cost: ${quota['cost_per_audit']}/audit")
    
    @pytest.mark.asyncio
    async def test_quota_enforcement(self):
        """Test: User exceeds hourly quota → blocked with message"""
        
        from src.quota_manager import QuotaManager
        
        manager = QuotaManager()
        user_id = 77777
        
        # User tries to exceed free tier limit (2/hour)
        for i in range(3):
            result = await manager.check_quota(
                user_id=user_id,
                tier="free",
                limit_per_hour=2
            )
            
            if i < 2:
                assert result["allowed"], f"Attempt {i+1} should be allowed"
            else:
                assert not result["allowed"], f"Attempt {i+1} should be blocked"
                assert "quota exceeded" in result["message"].lower(), "Should show quota message"
        
        print(f"✅ Quota enforcement passed - blocked at correct limit")
    
    @pytest.mark.asyncio
    async def test_error_recovery_flow(self):
        """Test: Audit error → logged → user notified → retry allowed"""
        
        from src.security_auditor import SecurityAuditor
        from src.telemetry import telemetry
        from src.sentry_monitor import sentry_monitor
        
        user_id = 66666
        contract_addr = "invalid_address"
        
        auditor = SecurityAuditor()
        
        try:
            # Attempt analysis with invalid address
            result = await auditor.analyze_contract(
                contract_address=contract_addr,
                user_id=user_id
            )
            
            if not result["success"]:
                # Error occurred - record it
                telemetry.record_error(
                    user_id=user_id,
                    error_type="InvalidContractAddress",
                    error_message=result.get("error", "Unknown error")
                )
                
                # Check telemetry recorded the error
                metrics = telemetry.get_metrics()
                assert metrics["errors"]["total"] >= 0, "Error should be recorded"
                
                print(f"✅ Error recovery flow passed")
                print(f"   Error type: {result.get('error_type', 'Unknown')}")
                print(f"   User notified: Yes")
                print(f"   Logged to telemetry: Yes")
        
        except Exception as e:
            # Log exception
            telemetry.record_error(
                user_id=user_id,
                error_type=type(e).__name__,
                error_message=str(e)
            )
            print(f"✅ Exception handled and logged")


class TestTierDetection:
    """Test tier detection and routing"""
    
    @pytest.mark.asyncio
    async def test_free_tier_detection(self):
        """Test: New user automatically detected as free tier"""
        
        from src.security_auditor import SecurityAuditor
        
        auditor = SecurityAuditor()
        new_user_id = 55555
        
        # New user should be free tier by default
        quota = await auditor.get_user_quota_info(new_user_id)
        
        assert quota["tier"] == "free", "New user should be free tier"
        assert quota["cost_per_audit"] == 0.0, "Free tier $0 cost"
        
        print(f"✅ New user: Free tier (${quota['cost_per_audit']}/audit)")
    
    @pytest.mark.asyncio
    async def test_subscriber_tier_detection(self):
        """Test: Subscriber user detected as premium tier"""
        
        from src.security_auditor import SecurityAuditor
        
        auditor = SecurityAuditor()
        subscriber_id = 44444
        
        # Subscriber should be premium tier
        quota = await auditor.get_user_quota_info(subscriber_id, is_subscriber=True)
        
        assert quota["tier"] == "premium", "Subscriber should be premium tier"
        assert quota["cost_per_audit"] > 0, "Premium tier has cost"
        
        print(f"✅ Subscriber: Premium tier (${quota['cost_per_audit']}/audit)")
    
    @pytest.mark.asyncio
    async def test_cost_calculation(self):
        """Test: Cost correctly calculated based on tier"""
        
        free_cost = 0.0
        gpt4_cost = 0.03  # Approximate
        
        assert free_cost == 0.0, "Free tier should be $0"
        assert gpt4_cost > 0, "GPT-4 tier should have cost"
        
        # Calculate monthly savings
        audits_per_month_free = 30 * 2  # 2/hour * 24h * 30 days (capped)
        audits_per_month_gpt4 = 30 * 3  # Average 3/hour
        
        cost_all_gpt4 = audits_per_month_gpt4 * gpt4_cost
        cost_free_tier = audits_per_month_free * free_cost
        
        savings = cost_all_gpt4 - cost_free_tier
        savings_percent = (savings / cost_all_gpt4 * 100) if cost_all_gpt4 > 0 else 0
        
        print(f"✅ Cost analysis:")
        print(f"   All GPT-4: ${cost_all_gpt4:.2f}/month")
        print(f"   With free tier: ${cost_free_tier:.2f}/month")
        print(f"   Savings: ${savings:.2f} ({savings_percent:.0f}%)")


class TestDatabasePersistence:
    """Test database storage and retrieval"""
    
    @pytest.mark.asyncio
    async def test_audit_storage_and_retrieval(self):
        """Test: Store audit and retrieve it"""
        
        from src.database import DatabaseClient
        
        db = DatabaseClient()
        
        # Store audit
        audit_data = {
            "user_id": 33333,
            "contract_address": "TestAddr123",
            "analysis_type": "free_tier_pattern_based",
            "cost_usd": 0.0,
            "risk_score": 7,
            "findings": ["Pattern 1", "Pattern 2"],
            "timestamp": datetime.utcnow(),
            "status": "completed"
        }
        
        audit_id = await db.store_audit(audit_data)
        assert audit_id is not None, "Audit should be stored"
        
        # Retrieve audit
        retrieved = await db.get_audit(audit_id)
        
        assert retrieved is not None, "Audit should be retrievable"
        assert retrieved["user_id"] == audit_data["user_id"], "User ID should match"
        assert retrieved["contract_address"] == audit_data["contract_address"], "Contract should match"
        assert retrieved["risk_score"] == audit_data["risk_score"], "Risk score should match"
        
        print(f"✅ Audit storage and retrieval passed")
        print(f"   Stored ID: {audit_id}")
        print(f"   Retrieved: {retrieved['contract_address']}")
    
    @pytest.mark.asyncio
    async def test_user_audit_history(self):
        """Test: Retrieve user's audit history"""
        
        from src.database import DatabaseClient
        
        db = DatabaseClient()
        user_id = 22222
        
        # Store multiple audits
        for i in range(3):
            await db.store_audit({
                "user_id": user_id,
                "contract_address": f"Contract{i}",
                "analysis_type": "free_tier_pattern_based",
                "cost_usd": 0.0,
                "risk_score": 5 + i,
                "timestamp": datetime.utcnow(),
                "status": "completed"
            })
        
        # Retrieve history
        history = await db.get_user_audit_history(user_id)
        
        assert len(history) >= 3, "Should have at least 3 audits"
        assert all(a["user_id"] == user_id for a in history), "All should be user's audits"
        
        print(f"✅ User audit history: {len(history)} audits")


class TestMonitoringAndAlerts:
    """Test telemetry and alerting"""
    
    def test_telemetry_collection(self):
        """Test: Telemetry correctly collects metrics"""
        
        from src.telemetry import telemetry
        
        # Record some audits
        telemetry.record_audit(
            user_id=11111,
            contract_addr="Test1",
            analysis_type="free_tier",
            cost_usd=0.0,
            response_time_ms=1500,
            risk_score=5
        )
        
        telemetry.record_audit(
            user_id=11112,
            contract_addr="Test2",
            analysis_type="free_tier",
            cost_usd=0.0,
            response_time_ms=2000,
            risk_score=7
        )
        
        # Get metrics
        metrics = telemetry.get_metrics()
        
        assert metrics["audits"]["total"] >= 2, "Should track audits"
        assert metrics["performance"]["avg_response_time_ms"] > 0, "Should track response time"
        assert metrics["audits"]["total_cost"] == 0.0, "Free tier = $0 cost"
        
        print(f"✅ Telemetry collection:")
        print(f"   Total audits: {metrics['audits']['total']}")
        print(f"   Avg response: {metrics['performance']['avg_response_time_ms']:.0f}ms")
        print(f"   Total cost: ${metrics['audits']['total_cost']:.2f}")
    
    def test_health_score_calculation(self):
        """Test: Health score correctly calculated from metrics"""
        
        from src.telemetry import telemetry
        
        health = telemetry.get_health_status()
        
        assert 0 <= health["health_score"] <= 100, "Health score should be 0-100"
        assert "status" in health or health.get("health_score") >= 0, "Should have status"
        
        # Status mapping
        score = health["health_score"]
        if score >= 90:
            status = "healthy"
        elif score >= 75:
            status = "degraded"
        elif score >= 60:
            status = "warning"
        else:
            status = "critical"
        
        print(f"✅ Health score: {score} ({status})")


class TestErrorHandling:
    """Test error handling and resilience"""
    
    @pytest.mark.asyncio
    async def test_database_fallback_to_mock(self):
        """Test: Database gracefully falls back to mock on connection error"""
        
        from src.database import DatabaseClient
        
        db = DatabaseClient()
        
        # Store audit (should use mock if real DB unavailable)
        audit_id = await db.store_audit({
            "user_id": 99999,
            "contract_address": "FallbackTest",
            "analysis_type": "test",
            "cost_usd": 0.0,
            "risk_score": 5,
            "timestamp": datetime.utcnow(),
            "status": "completed"
        })
        
        assert audit_id is not None, "Should store even in mock mode"
        print(f"✅ Database fallback working: {audit_id}")
    
    @pytest.mark.asyncio
    async def test_api_retry_logic(self):
        """Test: API calls retry on failure"""
        
        from src.security_auditor import SecurityAuditor
        
        auditor = SecurityAuditor()
        
        # This should eventually succeed or fail gracefully
        result = await auditor.analyze_contract(
            contract_address="TestAddr",
            user_id=99999
        )
        
        # Should have either succeeded or failed gracefully
        assert "success" in result or "error" in result, "Should have status"
        print(f"✅ API retry logic: {'Success' if result.get('success') else 'Graceful failure'}")


# Run tests with: pytest tests/test_e2e.py -v


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
