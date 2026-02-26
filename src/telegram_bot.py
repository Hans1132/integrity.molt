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
        "/quota - View your rate limits and usage\n"
        "/subscribe - Subscribe to premium tier\n"
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
    
    # Perform audit with user context (for quota and payment tracking)
    logger.info(f"Audit requested by user {user_id} for {contract_address}")
    audit_result = SecurityAuditor.analyze_contract(
        contract_address,
        contract_code="",
        user_id=user_id,
        is_subscriber=False  # TODO: Check actual subscription status
    )
    
    # Handle quota exceeded response
    if audit_result.get("status") == "quota_exceeded":
        quota_info = audit_result.get("quota_info", {})
        message = (
            f"❌ **Audit Limit Reached**\n\n"
            f"Reason: {audit_result.get('reason', 'Unknown')}\n\n"
            f"📊 Your Limits:\n"
            f"⏱️ Hourly: {quota_info.get('audits_this_hour', 0)}/{quota_info.get('hourly_limit', 0)}\n"
            f"📅 Daily: {quota_info.get('audits_today', 0)}/{quota_info.get('daily_limit', 0)}\n"
            f"📆 Monthly: {quota_info.get('audits_this_month', 0)}/{quota_info.get('monthly_limit', 0)}\n\n"
            f"💡 Upgrade to /subscribe for higher limits!"
        )
        await update.message.reply_text(message)
        return
    
    # Format and send result
    report = format_audit_report(audit_result)
    
    # Send report (split if too long for Telegram)
    if len(report) > 4096:
        # Split into chunks
        for i in range(0, len(report), 4096):
            await update.message.reply_text(report[i:i+4096])
    else:
        await update.message.reply_text(report)
    
    # Log cost and quota info
    if audit_result["status"] == "success":
        cost = audit_result.get("cost_usd", 0)
        logger.info(f"✅ Audit completed - Cost: ${cost:.4f}")
        
        quota_remaining = audit_result.get("quota_remaining", {})
        footer_msg = (
            f"✅ Audit complete!\n"
            f"📊 Risk Score: Analysis completed\n"
            f"💰 Cost: ${cost:.4f}\n"
            f"⏱️ Tokens used: {audit_result.get('tokens_used', 0)}\n\n"
            f"📊 **Your Quota Remaining**:\n"
        )
        
        if quota_remaining:
            footer_msg += (
                f"⏱️ This hour: {quota_remaining.get('audits_remaining_hour', 0)} audits\n"
                f"📅 Today: {quota_remaining.get('audits_remaining_day', 0)} audits\n"
                f"📆 This month: {quota_remaining.get('audits_remaining_month', 0)} audits"
            )
        else:
            footer_msg += "📊 Premium quota (unlimited)"
        
        await update.message.reply_text(footer_msg)
    elif audit_result.get("status") == "cached":
        await update.message.reply_text(
            "📊 Quota Information:\n"
            "⏱️ This hour: No quota consumed (cached result)\n"
            "📅 Today: No quota consumed (cached result)"
        )


async def quota_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle /quota command - Show user's rate limits and usage"""
    from src.quota_manager import quota_manager
    
    user_id = update.effective_user.id
    quota_info = quota_manager.get_user_quota_info(user_id)
    
    if quota_info.get("tier") == "premium":
        tier_name = "🌟 PREMIUM (Unlimited)"
    elif quota_info.get("tier") == "subscriber":
        tier_name = "⭐ SUBSCRIBER"
    else:
        tier_name = "📊 FREE"
    
    message = (
        f"📊 **Your Quota Status**\n\n"
        f"Tier: {tier_name}\n\n"
        f"**Hourly Limit**:\n"
        f"  {quota_info.get('audits_this_hour', 0)}/{quota_info.get('hourly_limit', 0)} audits\n"
        f"  Remaining: {quota_info.get('audits_remaining_hour', 0)}\n\n"
        f"**Daily Limit**:\n"
        f"  {quota_info.get('audits_today', 0)}/{quota_info.get('daily_limit', 0)} audits\n"
        f"  Remaining: {quota_info.get('audits_remaining_day', 0)}\n\n"
        f"**Monthly Limit**:\n"
        f"  {quota_info.get('audits_this_month', 0)}/{quota_info.get('monthly_limit', 0)} audits\n"
        f"  Remaining: {quota_info.get('audits_remaining_month', 0)}\n\n"
        f"**Budget**:\n"
        f"  Spent: {quota_info.get('spent_this_month_sol', 0):.3f} SOL\n"
        f"  Limit: {quota_info.get('budget_limit_sol', 0.1):.3f} SOL/month\n"
    )
    
    if quota_info.get("tier") == "free":
        message += (
            f"\n💡 **Upgrade to subscriber** for 5x more audits!\n"
            f"Type /subscribe to get started."
        )
    
    await update.message.reply_text(message)


async def subscribe_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle /subscribe command - Subscribe to premium tier"""
    from src.payment_processor import payment_processor
    
    user_id = update.effective_user.id
    
    # Check if already subscribed
    from src.quota_manager import quota_manager
    quota_info = quota_manager.get_user_quota_info(user_id)
    
    if quota_info.get("tier") in ["subscriber", "premium"]:
        expires = quota_info.get("subscription_expires", "unknown")
        await update.message.reply_text(
            f"✅ You're already subscribed!\n\n"
            f"Current tier: {quota_info.get('tier').upper()}\n"
            f"Expires: {expires}\n\n"
            f"Higher limits:\n"
            f"⏱️ 10 audits/hour (vs 2)\n"
            f"📅 50 audits/day (vs 5)\n"
            f"📆 Unlimited monthly audits"
        )
        return
    
    # Create subscription payment request
    subscription_payment = payment_processor.create_subscription_payment(
        user_id=user_id,
        tier="subscriber"
    )
    
    if subscription_payment.get("status") == "pending":
        amount = subscription_payment.get("amount_sol", 0.1)
        payment_id = subscription_payment.get("payment_id", "unknown")
        
        message = (
            f"⭐ **Subscribe to Premium**\n\n"
            f"Amount: {amount} SOL (~$6 USD)\n"
            f"Duration: 30 days\n\n"
            f"**You'll get**:\n"
            f"✅ 5x higher audit limits\n"
            f"✅ Unlimited monthly audits\n"
            f"✅ Priority support\n\n"
            f"💰 Payment ID: `{payment_id}`\n\n"
            f"Send {amount} SOL to: [Phase 3 - Phantom wallet integration]\n"
            f"Or reply with /confirm to retry payment"
        )
        await update.message.reply_text(message)
    else:
        await update.message.reply_text(
            "❌ Could not create subscription payment. Try again later."
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
    app.add_handler(CommandHandler("quota", quota_command))
    app.add_handler(CommandHandler("subscribe", subscribe_command))
    
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
