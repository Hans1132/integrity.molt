import pytest
from lib.parse_identity import parse, ParseError


def test_parse_returns_required_keys(good_identity_md):
    result = parse(good_identity_md)
    assert set(result.keys()) == {
        "role", "tagline", "free_skills", "paid_skills",
        "contact", "tone", "topics",
    }


def test_parse_role_value(good_identity_md):
    result = parse(good_identity_md)
    assert result["role"] == "security oracle for Solana"


def test_parse_topics_is_list_with_six_items(good_identity_md):
    result = parse(good_identity_md)
    assert isinstance(result["topics"], list)
    assert len(result["topics"]) == 6
    assert result["topics"][0] == "Mint authority risks"


def test_parse_free_skills_preserves_newlines(good_identity_md):
    result = parse(good_identity_md)
    # Free skills section is a bulleted block; parser keeps it as one string
    assert "quick_scan" in result["free_skills"]
    assert "program_verification_status" in result["free_skills"]


def test_parse_missing_required_section_raises(fixtures_dir):
    md = (fixtures_dir / "identity_missing_section.md").read_text()
    with pytest.raises(ParseError, match="missing required sections.*Topics"):
        parse(md)


def test_parse_too_few_topics_raises(fixtures_dir):
    md = (fixtures_dir / "identity_few_topics.md").read_text()
    with pytest.raises(ParseError, match="need >=5 topics, found 3"):
        parse(md)


def test_parse_empty_input_raises():
    with pytest.raises(ParseError, match="no '## ' sections found"):
        parse("")


def test_parse_no_sections_raises():
    with pytest.raises(ParseError, match="no '## ' sections found"):
        parse("# Just a title\n\nSome body text with no h2.\n")


import subprocess
import tempfile
from pathlib import Path

from lib.parse_identity import parse, to_env


def test_to_env_contains_required_keys(good_identity_md):
    parsed = parse(good_identity_md)
    env = to_env(parsed, "abc1234", "2026-05-23T13:45:12Z")
    for key in ("MOLTBOT_ROLE", "MOLTBOT_TAGLINE", "MOLTBOT_FREE_SKILLS",
                "MOLTBOT_PAID_SKILLS", "MOLTBOT_CONTACT", "MOLTBOT_TONE",
                "MOLTBOT_TOPICS_COUNT", "MOLTBOT_TOPIC_0", "MOLTBOT_TOPIC_5",
                "MOLTBOT_IDENTITY_UPDATED_AT", "MOLTBOT_IDENTITY_COMMIT"):
        assert f"{key}=" in env, f"missing {key} in env output"


def test_to_env_topics_count_matches_topics(good_identity_md):
    parsed = parse(good_identity_md)
    env = to_env(parsed, "abc1234", "2026-05-23T13:45:12Z")
    assert "MOLTBOT_TOPICS_COUNT=6" in env


def test_to_env_bash_source_roundtrip(good_identity_md, tmp_path):
    """bash source the generated env, then echo all vars — they must match input."""
    parsed = parse(good_identity_md)
    env = to_env(parsed, "abc1234", "2026-05-23T13:45:12Z")
    env_file = tmp_path / "identity.env"
    env_file.write_text(env)

    # bash -c 'source <file>; echo "$MOLTBOT_ROLE"' should return the role string.
    result = subprocess.run(
        ["bash", "-c", f"set -e; source {env_file}; echo \"$MOLTBOT_ROLE\""],
        capture_output=True, text=True, check=True,
    )
    assert result.stdout.strip() == "security oracle for Solana"

    result = subprocess.run(
        ["bash", "-c", f"set -e; source {env_file}; echo \"$MOLTBOT_TOPIC_0\""],
        capture_output=True, text=True, check=True,
    )
    assert result.stdout.strip() == "Mint authority risks"


def test_to_env_escapes_single_quotes():
    """Values containing apostrophes must round-trip through bash without breaking."""
    fake_parsed = {
        "role": "don't worry about it",
        "tagline": "it's fine",
        "free_skills": "single ' quote",
        "paid_skills": "two '' quotes",
        "contact": "no quotes",
        "tone": "plain",
        "topics": ["t'1", "t'2", "t'3", "t'4", "t'5"],
    }
    env = to_env(fake_parsed, "sha", "ts")
    with tempfile.NamedTemporaryFile("w", suffix=".env", delete=False) as f:
        f.write(env)
        path = f.name
    try:
        result = subprocess.run(
            ["bash", "-c", f"set -e; source {path}; echo \"$MOLTBOT_ROLE\""],
            capture_output=True, text=True, check=True,
        )
        assert result.stdout.strip() == "don't worry about it"
    finally:
        Path(path).unlink()
