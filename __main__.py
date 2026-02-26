"""
integrity.molt main entry point
Start the Telegram bot and agent
"""
import logging
import sys
from src.config import Config, validate_config
from src.telegram_bot import main as start_bot

# Setup logging
logging.basicConfig(
    level=Config.LOG_LEVEL,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


if __name__ == "__main__":
    try:
        logger.info("=" * 60)
        logger.info("🤖 integrity.molt Security Audit Agent")
        logger.info("=" * 60)
        
        # Validate configuration
        validate_config()
        logger.info("✅ Configuration validated")
        
        # Log startup info
        logger.info(f"Environment: {Config.ENVIRONMENT}")
        logger.info(f"LLM Model: {Config.GPT4_MODEL}")
        logger.info(f"Solana RPC: {Config.SOLANA_RPC_URL}")
        logger.info(f"API Cost threshold: ${Config.API_COST_THRESHOLD_USD}")
        
        # Start bot
        logger.info("🚀 Starting Telegram bot...")
        start_bot()
        
    except ValueError as e:
        logger.error(f"❌ Configuration error: {e}")
        sys.exit(1)
    except KeyboardInterrupt:
        logger.info("⏹️  Agent stopped by user")
        sys.exit(0)
    except Exception as e:
        logger.error(f"❌ Fatal error: {e}", exc_info=True)
        sys.exit(1)
