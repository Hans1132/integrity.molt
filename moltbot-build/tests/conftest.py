from pathlib import Path
import pytest


@pytest.fixture
def fixtures_dir() -> Path:
    return Path(__file__).parent / "fixtures"


@pytest.fixture
def good_identity_md(fixtures_dir: Path) -> str:
    return (fixtures_dir / "identity_good.md").read_text()
