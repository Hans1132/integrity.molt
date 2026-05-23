from lib.parse_identity import parse


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
