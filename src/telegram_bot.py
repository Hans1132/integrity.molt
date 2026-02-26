"""
Telegram Bot integration for integrity.molt
Handles user commands and audit requests
"""
import asyncio
import time
import logging
from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes, filters
from src.config import Config, validate_config

# Setup logging
logging.basicConfig(
    level=Config.LOG_LEVEL,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle /start command"""
    await update.message.reply_text(
        "👋 Welcome to integrity.molt!\n"
        "I perform security audits on Moltbook contracts.\n\n"
        "Commands:\n"
        "/audit <contract_address> - Analyze a contract\n"
        "/help - Show this message\n"
    )


async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle /help command"""
    await update.message.reply_text(
        "**integrity.molt Security Auditor**\n\n"
        "Commands:\n"
        "/audit <address> - Analyze contract security\n"
        "/status - Check audit queue status\n"
        "/history - View your audit history\n"
    )


async def audit_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """
    Handle /audit <contract_address> command
    This is the main entry point for security audits
    """
    user_id = update.effective_user.id
    
    # Check if address was provided
    if not context.args:
        await update.message.reply_text(
            "❌ Usage: /audit <contract_address>\n"
            "Example: /audit EvXNCtaoVuC1NQLQswAnqsbQKPgVTdjrrLKa8MpMJiLf"
        )
        return
    
    contract_address = context.args[0]
    
    # Send "analyzing" message
    await update.message.reply_text(
        f"🔍 Analyzing {contract_address[:8]}...\n"
        "Please wait while GPT-4 performs security analysis..."
    )
    
    # Import here to avoid circular imports
    from src.security_auditor import SecurityAuditor, format_audit_report
    
    # Perform audit
    logger.info(f"Audit requested by {user_id} for {contract_address}")
    audit_result = SecurityAuditor.analyze_contract(contract_address)
    
    # Format and send result
    report = format_audit_report(audit_result)
    
    # Send report (split if too long for Telegram)
    if len(report) > 4096:
        # Split into chunks
        for i in range(0, len(report), 4096):
            await update.message.reply_text(report[i:i+4096])
    else:
        await update.message.reply_text(report)
    
    # Log cost
    if audit_result["status"] == "success":
        cost = audit_result.get("cost_usd", 0)
        logger.info(f"✅ Audit completed - Cost: ${cost:.4f}")
        await update.message.reply_text(
            f"✅ Audit complete!\n"
            f"📊 Risk Score: Analysis completed\n"
            f"💰 Cost: ${cost:.4f}\n"
            f"⏱️ Tokens used: {audit_result.get('tokens_used', 0)}"
        )


async def status_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle /status command"""
    await update.message.reply_text(
        "✅ Agent Status: Running\n"
        "📊 Audits today: 0\n"
        "💰 API credit remaining: ~$5.00"
    )


def main() -> None:
    """Start the bot"""
    try:
        validate_config()
    except ValueError as e:
        logger.error(f"Configuration error: {e}")
        return
    
    # Fix for asyncio on Windows with Python 3.10+
    if asyncio.sys.platform == 'win32':
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    
    # Create and set event loop explicitly
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    
    # Create application
    app = Application.builder().token(Config.TELEGRAM_TOKEN).build()
    
    # Register command handlers
    app.add_handler(CommandHandler("start", start_command))
    app.add_handler(CommandHandler("help", help_command))
    app.add_handler(CommandHandler("audit", audit_command))
    app.add_handler(CommandHandler("status", status_command))
    
    # Start bot
    logger.info("🤖 integrity.molt bot starting...")
    retry_count = 0
    max_retries = 3
    
    try:
        while retry_count < max_retries:
            try:
                app.run_polling(allowed_updates=None, drop_pending_updates=True)
                break
            except Exception as e:
                if "Conflict" in str(e) and retry_count < max_retries - 1:
                    retry_count += 1
                    logger.warning(f"Conflict with Telegram API, retrying in 30s... (attempt {retry_count}/{max_retries})")
                    time.sleep(30)
                else:
                    raise
    except KeyboardInterrupt:
        logger.info("⏹️  Bot stopped by user")
    except Exception as e:
        logger.error(f"❌ Bot error: {e}", exc_info=True)
    finally:
        loop.close()


if __name__ == "__main__":
    main()
