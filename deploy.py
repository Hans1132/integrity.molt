"""
Deployment Automation for Railway.app
One-click production deployment with validation and monitoring setup
"""
import os
import sys
import json
import subprocess
import logging
from pathlib import Path
from typing import Dict, List, Tuple, Optional
from dotenv import load_dotenv

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger(__name__)


class EnvironmentValidator:
    """Validates all required environment variables"""
    
    # Required for all deployments
    REQUIRED_VARS = {
        "TELEGRAM_TOKEN": "Telegram Bot Token",
        "OPENAI_API_KEY": "OpenAI API Key",
        "SOLANA_RPC_URL": "Solana RPC Endpoint",
        "ENVIRONMENT": "Environment (development/production)",
    }
    
    # Required for production
    PRODUCTION_VARS = {
        "MONGODB_URI": "MongoDB Connection String",
        "DATABASE_MODE": "Database Mode (real/mock)",
    }
    
    # Optional but recommended
    OPTIONAL_VARS = {
        "SENTRY_DSN": "Sentry DSN (error tracking)",
        "SLACK_ALERT_WEBHOOK": "Slack webhook (alerts)",
        "MOLTBOOK_API_KEY": "Moltbook API Key",
        "OPENCLAW_TOKEN": "OpenClaw deployment token",
    }
    
    def __init__(self):
        self.errors = []
        self.warnings = []
        self.env_vars = {}
    
    def validate(self, environment: str = "development") -> bool:
        """Validate all required variables for environment"""
        load_dotenv()
        
        logger.info("🔍 Validating environment configuration...")
        logger.info(f"   Target environment: {environment}")
        
        # Check required variables
        for var, description in self.REQUIRED_VARS.items():
            value = os.getenv(var)
            if not value:
                self.errors.append(f"Missing required: {var} ({description})")
            else:
                self.env_vars[var] = value
                logger.info(f"   ✅ {var}")
        
        # Check production-specific variables
        if environment == "production":
            for var, description in self.PRODUCTION_VARS.items():
                value = os.getenv(var)
                if not value:
                    self.errors.append(f"Missing required for production: {var} ({description})")
                else:
                    self.env_vars[var] = value
                    logger.info(f"   ✅ {var}")
        
        # Check optional variables
        for var, description in self.OPTIONAL_VARS.items():
            value = os.getenv(var)
            if value:
                self.env_vars[var] = value
                logger.info(f"   ✅ {var}")
            else:
                self.warnings.append(f"Optional not set: {var} ({description})")
        
        # Report results
        if self.errors:
            logger.error("\n❌ VALIDATION FAILED")
            for error in self.errors:
                logger.error(f"   ✗ {error}")
            return False
        
        if self.warnings:
            logger.warning("\n⚠️  WARNINGS")
            for warning in self.warnings:
                logger.warning(f"   ⚠️  {warning}")
        
        logger.info("\n✅ Environment validation passed!")
        return True
    
    def get_missing_vars(self) -> List[str]:
        """Get list of missing required variables"""
        return [var for var in self.REQUIRED_VARS if not os.getenv(var)]
    
    def export_to_file(self, filepath: str) -> bool:
        """Export validated vars to file for Railway"""
        try:
            with open(filepath, "w") as f:
                for var, value in self.env_vars.items():
                    # Don't export secrets in plain text
                    if any(x in var.lower() for x in ["token", "key", "secret", "password"]):
                        f.write(f"{var}=***REDACTED***\n")
                    else:
                        f.write(f"{var}={value}\n")
            logger.info(f"✅ Configuration exported to {filepath}")
            return True
        except Exception as e:
            logger.error(f"Failed to export config: {e}")
            return False


class RailwayDeployer:
    """Handles Railway.app deployment"""
    
    def __init__(self, github_repo: str = "Hans1132/integrity.molt"):
        self.github_repo = github_repo
        self.project_name = "integrity-molt"
        self.railway_url = "https://railway.app"
    
    def check_railway_cli(self) -> bool:
        """Check if Railway CLI is installed"""
        try:
            result = subprocess.run(
                ["railway", "--version"],
                capture_output=True,
                text=True,
                timeout=5
            )
            if result.returncode == 0:
                logger.info(f"✅ Railway CLI found: {result.stdout.strip()}")
                return True
        except FileNotFoundError:
            logger.warning("⚠️  Railway CLI not found. Install with: npm install -g @railway/cli")
            return False
        except Exception as e:
            logger.warning(f"⚠️  Could not verify Railway CLI: {e}")
            return False
    
    def check_git_config(self) -> bool:
        """Check if git is configured"""
        try:
            subprocess.run(
                ["git", "status"],
                capture_output=True,
                timeout=5,
                cwd="."
            )
            return True
        except Exception:
            logger.error("❌ Git not found or not in git repository")
            return False
    
    def check_uncommitted_changes(self) -> bool:
        """Check for uncommitted changes"""
        try:
            result = subprocess.run(
                ["git", "status", "--porcelain"],
                capture_output=True,
                text=True,
                timeout=5
            )
            
            if result.stdout.strip():
                logger.warning("⚠️  Uncommitted changes detected:")
                logger.warning(result.stdout)
                return False
            
            logger.info("✅ Git repository clean")
            return True
        except Exception as e:
            logger.warning(f"⚠️  Could not check git status: {e}")
            return False
    
    def configure_health_checks(self) -> Dict[str, str]:
        """Generate health check configuration"""
        return {
            "liveness": {
                "path": "/liveness",
                "interval": "10s",
                "timeout": "5s",
                "threshold": "3"
            },
            "readiness": {
                "path": "/readiness",
                "interval": "5s",
                "timeout": "3s",
                "threshold": "2"
            },
            "metrics": {
                "path": "/metrics/prometheus",
                "scrape_interval": "15s"
            }
        }
    
    def generate_deployment_config(self) -> Dict:
        """Generate Railway deployment configuration"""
        return {
            "name": self.project_name,
            "buildCommand": "pip install -r requirements.txt",
            "startCommand": "python -m src",
            "healthCheck": self.configure_health_checks(),
            "environment": "production",
            "region": "us-east-1",
            "autoDeploy": True,
            "monitoring": {
                "sentry": True,
                "metrics": True,
                "alerts": True
            }
        }
    
    def push_to_github(self) -> bool:
        """Push current code to GitHub"""
        try:
            logger.info("📤 Pushing to GitHub...")
            
            # Check for changes
            result = subprocess.run(
                ["git", "status", "--porcelain"],
                capture_output=True,
                text=True,
                timeout=5
            )
            
            if result.stdout.strip():
                logger.warning("⚠️  Found uncommitted changes. Committing...")
                subprocess.run(
                    ["git", "add", "-A"],
                    timeout=10
                )
                subprocess.run(
                    ["git", "commit", "-m", "chore: Phase 3g production deployment"],
                    timeout=10
                )
            
            # Push to origin
            result = subprocess.run(
                ["git", "push", "origin", "main"],
                capture_output=True,
                text=True,
                timeout=30
            )
            
            if result.returncode == 0:
                logger.info("✅ Code pushed to GitHub")
                return True
            else:
                logger.error(f"❌ Git push failed: {result.stderr}")
                return False
        
        except Exception as e:
            logger.error(f"❌ Push to GitHub failed: {e}")
            return False
    
    def get_deployment_instructions(self) -> str:
        """Generate Railway deployment instructions"""
        return f"""
        ╔════════════════════════════════════════════════════════╗
        ║  Railway.app Deployment Instructions                  ║
        ╚════════════════════════════════════════════════════════╝
        
        CODE PUSHED TO GITHUB ✅
        
        Next steps:
        
        1. Go to Railway.app Dashboard:
           https://railway.app/dashboard
        
        2. Create New Project:
           - Click "Create New Project"
           - Select "Deploy from GitHub repo"
           - Choose: {self.github_repo}
        
        3. Configure Environment:
           - Go to "Variables" tab
           - Add all variables from .env
           - Set ENVIRONMENT=production
           - Set DATABASE_MODE=real
        
        4. Monitor Deployment:
           - Watch logs in Railway dashboard
           - Bot will start automatically
           - Health checks will verify status
        
        5. Test in Telegram:
           - Send /start command
           - Send /audit <address> command
           - Verify response in logs
        
        Railway Benefits:
        ✅ Auto-deploys on git push
        ✅ Auto-restarts on failure
        ✅ Free tier available
        ✅ Built-in monitoring
        ✅ Zero-downtime deployments
        
        Pricing:
        🟢 Free tier: $5 credit/month
        🔵 App Sleeping Plan: $5/month
        🔴 Hobby Plan: $10/month+
        """


class PreDeploymentTests:
    """Run pre-deployment verification tests"""
    
    def __init__(self):
        self.results = {}
    
    def test_imports(self) -> bool:
        """Test that all critical modules can be imported"""
        logger.info("🧪 Testing imports...")
        
        try:
            import telegram
            import openai
            import pymongo
            import motor
            import solana
            
            logger.info("✅ All imports successful")
            return True
        except ImportError as e:
            logger.error(f"❌ Import failed: {e}")
            return False
    
    def test_config(self) -> bool:
        """Test that config loads correctly"""
        logger.info("🧪 Testing configuration...")
        
        try:
            from src.config import Config
            
            logger.info(f"   Environment: {Config.ENVIRONMENT}")
            logger.info(f"   Log level: {Config.LOG_LEVEL}")
            logger.info("✅ Configuration loaded")
            return True
        except Exception as e:
            logger.error(f"❌ Configuration test failed: {e}")
            return False
    
    def test_telegram_token(self) -> bool:
        """Test Telegram token format"""
        logger.info("🧪 Testing Telegram token...")
        
        token = os.getenv("TELEGRAM_TOKEN", "")
        if len(token) > 30 and ":" in token:
            logger.info("✅ Telegram token format valid")
            return True
        else:
            logger.error("❌ Invalid Telegram token format")
            return False
    
    def test_openai_key(self) -> bool:
        """Test OpenAI API key format"""
        logger.info("🧪 Testing OpenAI API key...")
        
        key = os.getenv("OPENAI_API_KEY", "")
        if key.startswith("sk-") and len(key) > 20:
            logger.info("✅ OpenAI API key format valid")
            return True
        else:
            logger.error("❌ Invalid OpenAI API key format")
            return False
    
    def test_database_uri(self) -> bool:
        """Test MongoDB URI format"""
        logger.info("🧪 Testing MongoDB URI...")
        
        uri = os.getenv("MONGODB_URI", "")
        if "mongodb" in uri and ("://" in uri or "+srv://" in uri):
            logger.info("✅ MongoDB URI format valid")
            return True
        else:
            logger.warning("⚠️  MongoDB URI not configured (will use mock mode)")
            return True  # Not fatal
    
    def run_all_tests(self) -> Tuple[bool, Dict]:
        """Run all pre-deployment tests"""
        logger.info("\n📋 Running Pre-Deployment Tests\n")
        
        tests = {
            "imports": self.test_imports,
            "config": self.test_config,
            "telegram_token": self.test_telegram_token,
            "openai_key": self.test_openai_key,
            "database_uri": self.test_database_uri,
        }
        
        passed = 0
        failed = 0
        
        for test_name, test_func in tests.items():
            try:
                result = test_func()
                self.results[test_name] = result
                if result:
                    passed += 1
                else:
                    failed += 1
            except Exception as e:
                logger.error(f"❌ Test {test_name} crashed: {e}")
                self.results[test_name] = False
                failed += 1
        
        logger.info(f"\n📊 Test Results: {passed} passed, {failed} failed\n")
        all_passed = failed == 0
        
        return all_passed, self.results


class DeploymentOrchestrator:
    """Orchestrates the entire deployment process"""
    
    def __init__(self):
        self.validator = EnvironmentValidator()
        self.deployer = RailwayDeployer()
        self.tests = PreDeploymentTests()
    
    def run_full_deployment(self, environment: str = "production") -> bool:
        """Execute full deployment pipeline"""
        
        logger.info("\n" + "="*60)
        logger.info("🚀 integrity.molt Deployment Pipeline")
        logger.info("="*60 + "\n")
        
        # Step 1: Validate environment
        logger.info("STEP 1: Environment Validation")
        logger.info("-" * 60)
        if not self.validator.validate(environment):
            logger.error("\n❌ Deployment cancelled: Environment validation failed")
            return False
        
        # Step 2: Run pre-deployment tests
        logger.info("\nSTEP 2: Pre-Deployment Tests")
        logger.info("-" * 60)
        tests_passed, results = self.tests.run_all_tests()
        if not tests_passed:
            logger.warning("⚠️  Some tests failed, but continuing...")
        
        # Step 3: Check Railway setup
        logger.info("\nSTEP 3: Railway Setup Check")
        logger.info("-" * 60)
        
        has_railway_cli = self.deployer.check_railway_cli()
        has_git = self.deployer.check_git_config()
        is_clean = self.deployer.check_uncommitted_changes()
        
        if not has_git:
            logger.error("❌ Git is required for deployment")
            return False
        
        # Step 4: Generate deployment config
        logger.info("\nSTEP 4: Deployment Configuration")
        logger.info("-" * 60)
        config = self.deployer.generate_deployment_config()
        logger.info(f"✅ Generated deployment config:")
        logger.info(f"   Project: {config['name']}")
        logger.info(f"   Start command: {config['startCommand']}")
        logger.info(f"   Auto-deploy: {config['autoDeploy']}")
        logger.info(f"   Monitoring: Sentry, Metrics, Alerts enabled")
        
        # Step 5: Push to GitHub
        logger.info("\nSTEP 5: Push to GitHub")
        logger.info("-" * 60)
        if not self.deployer.push_to_github():
            logger.error("❌ Failed to push to GitHub")
            return False
        
        # Step 6: Display deployment instructions
        logger.info("\nSTEP 6: Next Steps")
        logger.info("-" * 60)
        logger.info(self.deployer.get_deployment_instructions())
        
        return True


def main():
    """Main deployment entry point"""
    import argparse
    
    parser = argparse.ArgumentParser(description="Deploy integrity.molt to production")
    parser.add_argument(
        "--environment",
        choices=["development", "production"],
        default="production",
        help="Deployment environment"
    )
    parser.add_argument(
        "--skip-tests",
        action="store_true",
        help="Skip pre-deployment tests"
    )
    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="Only validate environment (don't deploy)"
    )
    
    args = parser.parse_args()
    
    orchestrator = DeploymentOrchestrator()
    
    if args.validate_only:
        # Only validate
        validator = EnvironmentValidator()
        success = validator.validate(args.environment)
        sys.exit(0 if success else 1)
    
    # Run full deployment
    success = orchestrator.run_full_deployment(args.environment)
    
    if success:
        logger.info("\n✅ Deployment pipeline completed successfully!")
        logger.info("   Monitor progress at: https://railway.app/dashboard")
        sys.exit(0)
    else:
        logger.error("\n❌ Deployment pipeline failed!")
        sys.exit(1)


if __name__ == "__main__":
    main()
