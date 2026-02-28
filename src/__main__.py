"""
integrity.molt main entry point
Start both Telegram bot and FastAPI marketplace API
Both run concurrently: bot handles user commands, API handles Moltbook requests
"""
import logging
import sys
import threading
import asyncio
from src.config import Config, validate_config
from src.agent_config import AgentConfig
from src.telegram_bot import main as start_bot
from src.autonomous_auditor import start_autonomous_audit_loop

# Setup logging
logging.basicConfig(
    level=Config.LOG_LEVEL,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def run_telegram_bot():
    """Run Telegram bot in main thread"""
    try:
        logger.info("📱 Starting Telegram bot thread...")
        start_bot()
    except Exception as e:
        logger.error(f"❌ Telegram bot error: {e}", exc_info=True)


def run_marketplace_api():
    """Run FastAPI marketplace server in separate thread"""
    try:
        logger.info("🌐 Starting Marketplace API server...")
        
        import uvicorn
        from src.marketplace_api import app
        
        uvicorn.run(
            app,
            host=Config.MARKETPLACE_API_HOST,
            port=Config.MARKETPLACE_API_PORT,
            log_level="info"
        )
    except Exception as e:
        logger.error(f"❌ Marketplace API error: {e}", exc_info=True)


def run_autonomous_audit_loop():
    """Run autonomous audit processor in separate thread"""
    try:
        logger.info("🤖 Starting autonomous audit loop...")
        
        # Create new event loop for this thread
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        # Run the audit loop
        loop.run_until_complete(
            start_autonomous_audit_loop(
                interval_seconds=Config.AUDIT_QUEUE_CHECK_INTERVAL
            )
        )
    except Exception as e:
        logger.error(f"❌ Autonomous audit loop error: {e}", exc_info=True)


if __name__ == "__main__":
    try:
        logger.info("=" * 60)
        logger.info("🤖 integrity.molt Autonomous Security Audit Agent")
        logger.info("=" * 60)
        
        # Validate configuration
        validate_config()
        logger.info("✅ Configuration validated")
        
        # Log agent on-chain identity
        AgentConfig.log_agent_config()
        
        # Generate identity header (test)
        try:
            if AgentConfig.AGENT_PRIVATE_KEY:
                headers = AgentConfig.get_identity_header()
                logger.info("✅ Agent identity verification ready")
                logger.info(f"✅ Verification message: 'Officially Verified by {AgentConfig.IDENTITY_NAME}'")
            else:
                logger.warning("⚠️  AGENT_PRIVATE_KEY not set - agent identity verification disabled")
        except Exception as e:
            logger.warning(f"⚠️  Identity verification setup failed: {e}")
        
        # Log startup info
        logger.info(f"Environment: {Config.ENVIRONMENT}")
        logger.info(f"LLM Model: {Config.GPT4_MODEL}")
        logger.info(f"Solana RPC: {Config.SOLANA_RPC_URL}")
        logger.info(f"Telegram: Enabled")
        logger.info(f"Marketplace API: {Config.MARKETPLACE_API_HOST}:{Config.MARKETPLACE_API_PORT}")
        logger.info(f"Max Concurrent Audits: {Config.MAX_CONCURRENT_AUDITS}")
        logger.info("")
        logger.info("=" * 60)
        logger.info("🚀 Starting all components...")
        logger.info("=" * 60)
        
        # Thread 1: Telegram Bot (blocking)
        telegram_thread = threading.Thread(
            target=run_telegram_bot,
            name="TelegramBot",
            daemon=False
        )
        telegram_thread.start()
        logger.info("✅ Telegram bot thread started")
        
        # Thread 2: FastAPI Marketplace API (blocking)
        api_thread = threading.Thread(
            target=run_marketplace_api,
            name="MarketplaceAPI",
            daemon=False
        )
        api_thread.start()
        logger.info("✅ Marketplace API thread started")
        
        # Thread 3: Autonomous Audit Loop
        audit_thread = threading.Thread(
            target=run_autonomous_audit_loop,
            name="AutonomousAuditor",
            daemon=False
        )
        audit_thread.start()
        logger.info("✅ Autonomous auditor thread started")
        
        logger.info("")
        logger.info("=" * 60)
        logger.info("🎯 integrity.molt is now FULLY OPERATIONAL")
        logger.info("")
        logger.info("Components running:")
        logger.info("  ✅ Telegram Bot - User commands")
        logger.info("  ✅ Marketplace API - Moltbook requests")
        logger.info("  ✅ Autonomous Auditor - Background processing")
        logger.info("")
        logger.info("Earning money on Moltbook marketplace...")
        logger.info("=" * 60)
        
        # Wait for all threads
        telegram_thread.join()
        api_thread.join()
        audit_thread.join()
        
    except ValueError as e:
        logger.error(f"❌ Configuration error: {e}")
        sys.exit(1)
    except KeyboardInterrupt:
        logger.info("⏹️  Agent stopped by user")
        sys.exit(0)
    except Exception as e:
        logger.error(f"❌ Fatal error: {e}", exc_info=True)
        sys.exit(1)

