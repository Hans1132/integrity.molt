"""
Configuration module for integrity.molt
Loads settings from .env file
"""
import os
import logging
from pathlib import Path
from typing import Optional
from dotenv import load_dotenv

# Load .env file from project root
ENV_PATH = Path(__file__).parent.parent / ".env"
load_dotenv(dotenv_path=ENV_PATH, override=False)


class Config:
    """Main configuration container"""
    
    # Telegram Bot
    TELEGRAM_TOKEN: str = os.getenv("TELEGRAM_TOKEN", "")
    
    # OpenAI API
    OPENAI_API_KEY: str = os.getenv("OPENAI_API_KEY", "")
    GPT4_MODEL: str = os.getenv("GPT4_MODEL", "gpt-4-turbo")
    GPT4_MAX_TOKENS: int = int(os.getenv("GPT4_MAX_TOKENS", "4000"))
    GPT4_TEMPERATURE: float = float(os.getenv("GPT4_TEMPERATURE", "0.3"))
    
    # Solana
    SOLANA_RPC_URL: str = os.getenv("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com")
    SOLANA_PUBLIC_KEY: str = os.getenv("SOLANA_PUBLIC_KEY", "")
    
    # Cloudflare R2 (Phase 2 - Optional)
    R2_ACCOUNT_ID: str = os.getenv("R2_ACCOUNT_ID", "")
    R2_ACCESS_KEY_ID: str = os.getenv("R2_ACCESS_KEY_ID", "")
    R2_SECRET_ACCESS_KEY: str = os.getenv("R2_SECRET_ACCESS_KEY", "")
    R2_BUCKET_NAME: str = os.getenv("R2_BUCKET_NAME", "integrity-molt-audits")
    
    @staticmethod
    def r2_enabled() -> bool:
        """Check if R2 storage is configured (Phase 2)"""
        return bool(Config.R2_ACCOUNT_ID and Config.R2_ACCESS_KEY_ID and Config.R2_SECRET_ACCESS_KEY)
    
    # Metaplex
    METAPLEX_PROGRAM_ID: str = os.getenv("METAPLEX_PROGRAM_ID", "4XKv23WzTb9ZpwLCxfQ3k2ChFmQwrUuuazpDKq3ikVSJ")
    
    # Environment
    ENVIRONMENT: str = os.getenv("ENVIRONMENT", "development")
    LOG_LEVEL: str = os.getenv("LOG_LEVEL", "INFO")
    
    # Application Settings
    MAX_AUDIT_SIZE_BYTES: int = int(os.getenv("MAX_AUDIT_SIZE_BYTES", "50000"))
    AUDIT_TIMEOUT_SECONDS: int = int(os.getenv("AUDIT_TIMEOUT_SECONDS", "120"))
    API_COST_THRESHOLD_USD: float = float(os.getenv("API_COST_THRESHOLD_USD", "4.50"))


def validate_config() -> bool:
    """
    Validate that critical configuration is set.
    Returns True if valid, raises error otherwise.
    """
    errors = []
    
    if not Config.TELEGRAM_TOKEN:
        errors.append("TELEGRAM_TOKEN not set in .env")
    if not Config.OPENAI_API_KEY:
        errors.append("OPENAI_API_KEY not set in .env")
    if not Config.SOLANA_PUBLIC_KEY:
        errors.append("SOLANA_PUBLIC_KEY not set in .env")
    
    if errors:
        raise ValueError(f"Configuration errors:\n" + "\n".join(errors))
    
    # Warn about missing optional services (Phase 2)
    if not Config.r2_enabled():
        logger = logging.getLogger(__name__)
        logger.warning("⚠️  R2 storage not configured - Phase 2 feature, audit reports will not persist")
    
    return True


if __name__ == "__main__":
    # Quick validation test
    try:
        validate_config()
        print("✅ Configuration valid!")
        print(f"Environment: {Config.ENVIRONMENT}")
        print(f"GPT-4 Model: {Config.GPT4_MODEL}")
    except ValueError as e:
        print(f"❌ {e}")
