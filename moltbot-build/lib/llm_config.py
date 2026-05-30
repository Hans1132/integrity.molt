"""Read/write the LLM model setting that heartbeat.sh sources."""
from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path

_KEY = "MOLTBOT_LLM_MODEL"
_LINE_RE = re.compile(rf"^\s*{_KEY}\s*=\s*(\S+)\s*$", re.MULTILINE)
# Defense in depth: model names persisted to the env file must match a safe token
# pattern. Defends against shell-injection or env-file-syntax corruption if the
# caller's allowlist check is ever bypassed.
_MODEL_TOKEN_RE = re.compile(r"^[A-Za-z0-9._/-]+$")


def current_model(llm_config_file: Path) -> str | None:
    if not llm_config_file.is_file():
        return None
    m = _LINE_RE.search(llm_config_file.read_text())
    return m.group(1) if m else None


def allowed_models(allowed_models_file: Path) -> list[str]:
    if not allowed_models_file.is_file():
        return []
    return [
        line.strip()
        for line in allowed_models_file.read_text().splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]


def set_model(llm_config_file: Path, model: str) -> None:
    """Atomic write: temp file in same dir, then rename."""
    if not _MODEL_TOKEN_RE.fullmatch(model):
        raise ValueError(f"model name contains unsafe characters: {model!r}")
    directory = llm_config_file.parent
    directory.mkdir(parents=True, exist_ok=True)
    content = f"{_KEY}={model}\n"
    fd, tmp_path = tempfile.mkstemp(prefix=".llm-config.", dir=str(directory))
    try:
        with os.fdopen(fd, "w") as f:
            f.write(content)
        os.replace(tmp_path, llm_config_file)
    except Exception:
        try:
            os.unlink(tmp_path)
        except FileNotFoundError:
            pass
        raise
