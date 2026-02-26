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
    """Handle /subscribe command - Subscribe to premium tier with Phantom integration"""
    from src.payment_processor import payment_processor
    from src.phantom_wallet import phantom_wallet
    from src.payment_signer import payment_signer
    from src.database import db_client
    
    user_id = update.effective_user.id
    
    # Ensure user exists in database
    db_client.insert_user(user_id, {"tier": "free"})
    
    # Check if already subscribed
    from src.quota_manager import quota_manager
    quota_info = quota_manager.get_user_quota_info(user_id)
    
    if quota_info.get("tier") in ["subscriber", "premium"]:
        expires = quota_info.get("subscription_expires", "unknown")
        await update.message.reply_text(
            f"✅ You're already subscribed!\n\n"
            f"Current tier: {quota_info.get('tier').upper()}\n"
            f"Expires: {expires}\n\n"
            f"📊 **Your Benefits**:\n"
            f"⏱️ {quota_info.get('hourly_limit')} audits/hour\n"
            f"📅 {quota_info.get('daily_limit')} audits/day\n"
            f"💰 Budget: {quota_info.get('budget_limit_sol')} SOL/month\n\n"
            f"Want to upgrade to Premium? Use /subscribe premium"
        )
        return
    
    # Determine tier from arguments
    tier = "subscriber"  # default
    if context.args and context.args[0] in ["subscriber", "premium"]:
        tier = context.args[0]
    
    # Display subscription options
    if tier == "subscriber":
        tier_info = {
            "price_sol": 0.1,
            "price_usd": "$6",
            "audits_hour": 10,
            "audits_day": 50,
            "audits_month": 999,
            "benefits": [
                "✅ 5x higher audit limits",
                "✅ Unlimited monthly audits",
                "✅ Priority support"
            ]
        }
    else:  # premium
        tier_info = {
            "price_sol": 1.0,
            "price_usd": "$60",
            "audits_hour": 20,
            "audits_day": 100,
            "audits_month": 9999,
            "benefits": [
                "✅ Highest rate limits",
                "✅ Truly unlimited audits",
                "✅ Priority support",
                "✅ API access (coming soon)",
                "✅ Custom reports (coming soon)"
            ]
        }
    
    # Create subscription payment
    subscription_payment = payment_processor.create_subscription_payment(
        user_id=user_id,
        tier=tier
    )
    
    if subscription_payment.get("status") != "pending":
        await update.message.reply_text(
            "❌ Could not create subscription. Try again later."
        )
        return
    
    # Generate payment transaction for signing
    payment_tx = payment_signer.create_subscription_payment_transaction(
        payment_id=subscription_payment['payment_id'],
        user_id=user_id,
        amount_lamports=subscription_payment['amount_lamports'],
        tier=tier,
        duration_days=30
    )
    
    # Create Phantom wallet signing request
    signing_request = phantom_wallet.create_signing_request(
        user_id=user_id,
        transaction_type="subscription",
        amount_lamports=subscription_payment['amount_lamports'],
        contract_address="integrity.molt",
        metadata={
            "tier": tier,
            "duration_days": 30,
            "payment_id": subscription_payment['payment_id']
        }
    )
    
    # Build subscription message
    benefits_list = "\n".join(tier_info["benefits"])
    
    message = (
        f"⭐ **{tier.upper()} Subscription**\n\n"
        f"💰 Price: {tier_info['price_sol']} SOL (~{tier_info['price_usd']})\n"
        f"📅 Duration: 30 days (auto-renew)\n\n"
        f"📊 **Your New Limits**:\n"
        f"⏱️ {tier_info['audits_hour']} audits per hour\n"
        f"📅 {tier_info['audits_day']} audits per day\n"
        f"📆 {tier_info['audits_month']} audits per month\n"
        f"💵 Budget: {'Unlimited' if tier == 'premium' else f'{tier_info[\"price_sol\"] * 100:.1f} SOL/month'}\n\n"
        f"🎁 **What You Get**:\n"
        f"{benefits_list}\n\n"
        f"**Next Steps**:\n"
        f"1️⃣ Open your Phantom wallet app or browser extension\n"
        f"2️⃣ Look for a signing request from integrity.molt\n"
        f"3️⃣ Review the transaction details\n"
        f"4️⃣ Tap 'Approve' to confirm\n"
        f"5️⃣ Your subscription will activate immediately!\n\n"
        f"🔐 **Request ID**: `{signing_request.get('request_id')}`\n"
        f"(Save this for support)\n\n"
        f"📞 Questions? Type /help or reply to this message"
    )
    
    await update.message.reply_text(message)
    
    # Send follow-up with status updates
    import asyncio
    await asyncio.sleep(2)
    
    status_msg = (
        f"📋 **Payment Details**\n\n"
        f"Amount: {subscription_payment['amount_sol']} SOL\n"
        f"Recipients:\n"
        f"  • integrity.molt (90%): {(subscription_payment['amount_lamports'] * 0.9) / 1_000_000_000:.3f} SOL\n"
        f"  • Moltbook fee (10%): {(subscription_payment['amount_lamports'] * 0.1) / 1_000_000_000:.3f} SOL\n\n"
        f"⏰ This request expires in 5 minutes\n\n"
        f"💡 **Didn't see the request in your wallet?**\n"
        f"1. Make sure you have Phantom installed\n"
        f"2. Open Phantom and check for notifications\n"
        f"3. Try refreshing the Phantom app\n"
        f"4. Use the deep link below:\n"
        f"`{signing_request.get('deeplink', 'phantom://browse')}`"
    )
    
    await update.message.reply_text(status_msg)



async def history_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle /history command - Show user's audit history"""
    from src.database import db_client
    
    user_id = update.effective_user.id
    
    # Get limit from arguments (default 10)
    limit = 10
    if context.args:
        try:
            limit = min(int(context.args[0]), 50)  # Max 50
        except ValueError:
            pass
    
    try:
        # Retrieve audit history from database
        audits = db_client.get_user_audits(user_id, limit=limit)
        
        if not audits:
            await update.message.reply_text(
                "📭 No audit history yet.\n\n"
                "Start with `/audit <contract_address>` to perform your first security analysis!"
            )
            return
        
        # Format history
        history_msg = f"📚 **Your Audit History** ({len(audits)} audits)\n\n"
        
        for i, audit in enumerate(audits, 1):
            contract_short = audit.get("contract_address", "unknown")[:16]
            risk = audit.get("risk_score", "N/A")
            date = audit.get("created_at", "unknown")[:10]  # YYYY-MM-DD
            status_emoji = {
                1: "🟩", 2: "🟩", 3: "🟨", 4: "🟨", 5: "🟨",
                6: "🟧", 7: "🟧", 8: "🔴", 9: "🔴", 10: "🔴"
            }.get(risk, "⚪")
            
            history_msg += (
                f"{i}. {status_emoji} **Risk {risk}/10** | {date}\n"
                f"   Contract: `{contract_short}...`\n"
            )
            
            if audit.get("r2_url"):
                history_msg += f"   📄 [View Report]({audit['r2_url']})\n"
            
            history_msg += "\n"
        
        # Pagination info
        if len(audits) >= limit:
            history_msg += f"📌 Showing {limit} most recent audits\n"
            history_msg += f"Use `/history 20` to see more (max 50)"
        
        await update.message.reply_text(history_msg)
    
    except Exception as e:
        logger.error(f"❌ History retrieval failed: {e}")
        await update.message.reply_text(
            "❌ Error retrieving history. Try again later."
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
    app.add_handler(CommandHandler("history", history_command))
    
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
