"""Environment loader. Validate at startup, fail fast on missing required fields."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


@dataclass(frozen=True)
class Config:
    telegram_bot_token: str
    authorized_user_id: int
    log_level: str
    x402_base_url: str
    moltbook_api_base: str
    moltbook_api_key_file: Path
    llm_config_file: Path
    allowed_models_file: Path
    scanner_reports_dir: Path
    heartbeat_trigger_file: Path
    heartbeat_marker_file: Path
    heartbeat_runner_unit: str
    identity_pull_trigger_file: Path
    identity_env_file: Path
    identity_repo_path: Path
    identity_runner_unit: str
    own_moltbook_user: str
    moltbook_api_key: str  # cached at startup, never logged


def _require(name: str) -> str:
    val = os.environ.get(name, "").strip()
    if not val:
        raise RuntimeError(f"required env var missing or empty: {name}")
    return val


def _read_secret(path: Path) -> str:
    """Read a secret file at startup; fail fast with a clear message on any problem."""
    if not path.is_file():
        raise RuntimeError(f"moltbook api key file not readable: {path}")
    try:
        content = path.read_text().strip()
    except OSError as e:
        raise RuntimeError(f"moltbook api key file read failed: {path}: {e}") from e
    if not content:
        raise RuntimeError(f"moltbook api key file empty or unreadable: {path}")
    return content


def load() -> Config:
    # EnvironmentFile= populates env in systemd; for dev, load .env too.
    load_dotenv(override=False)

    try:
        user_id = int(_require("AUTHORIZED_USER_ID"))
    except ValueError as e:
        raise RuntimeError(f"AUTHORIZED_USER_ID must be integer: {e}") from e

    key_file = Path(_require("MOLTBOOK_API_KEY_FILE"))
    return Config(
        telegram_bot_token=_require("TELEGRAM_BOT_TOKEN"),
        authorized_user_id=user_id,
        log_level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        x402_base_url=os.environ.get("X402_BASE_URL", "http://127.0.0.1:3402"),
        moltbook_api_base=os.environ.get("MOLTBOOK_API_BASE", "https://www.moltbook.com/api/v1"),
        moltbook_api_key_file=key_file,
        llm_config_file=Path(os.environ.get("LLM_CONFIG_FILE", "/etc/moltbot/llm-config.env")),
        allowed_models_file=Path(os.environ.get("ALLOWED_MODELS_FILE", "/etc/moltbot/allowed-models.txt")),
        scanner_reports_dir=Path(os.environ.get("SCANNER_REPORTS_DIR", "/root/scanner/reports")),
        heartbeat_trigger_file=Path(os.environ.get("HEARTBEAT_TRIGGER_FILE", "/var/run/moltbot/trigger-heartbeat")),
        heartbeat_marker_file=Path(os.environ.get("HEARTBEAT_MARKER_FILE", "/var/run/moltbot/last-heartbeat")),
        heartbeat_runner_unit=os.environ.get("HEARTBEAT_RUNNER_UNIT", "moltbot-heartbeat-runner.service"),
        identity_pull_trigger_file=Path(os.environ.get("IDENTITY_PULL_TRIGGER_FILE", "/var/run/moltbot/trigger-identity-pull")),
        identity_env_file=Path(os.environ.get("IDENTITY_ENV_FILE", "/etc/moltbot/identity.env")),
        identity_repo_path=Path(os.environ.get("IDENTITY_REPO_PATH", "/root/x402-server")),
        identity_runner_unit=os.environ.get("IDENTITY_RUNNER_UNIT", "moltbot-identity-pull-runner.service"),
        own_moltbook_user=os.environ.get("OWN_MOLTBOOK_USER", "integrity_molt"),
        moltbook_api_key=_read_secret(key_file),
    )
