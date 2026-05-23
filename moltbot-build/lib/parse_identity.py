"""Parse docs/IDENTITY.md → key-value mapping for identity.env."""
from __future__ import annotations

import re

REQUIRED_SECTIONS = ("Role", "Tagline", "Free skills", "Paid skills",
                     "Contact", "Topics", "Tone")
SECTION_RE = re.compile(r"^##\s+(.+?)\s*$", re.MULTILINE)
BULLET_RE = re.compile(r"^[-*]\s+(.+)$")


class ParseError(Exception):
    """Raised when IDENTITY.md is structurally invalid."""


def parse(md_text: str) -> dict:
    """Parse markdown into structured identity dict.

    Required: '## Role', '## Tagline', '## Free skills', '## Paid skills',
    '## Contact', '## Topics', '## Tone'.
    Topics must contain >=5 bullet items.
    """
    matches = list(SECTION_RE.finditer(md_text))
    if not matches:
        raise ParseError("no '## ' sections found")

    sections: dict[str, str] = {}
    for i, m in enumerate(matches):
        # Strip section name down to first word group (handles "Paid skills (x402 USDC)")
        raw = m.group(1).strip()
        # Canonical name: split on first " (" to drop parenthetical qualifier
        name = raw.split(" (", 1)[0].strip()
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(md_text)
        sections[name] = md_text[start:end].strip()

    missing = [s for s in REQUIRED_SECTIONS if s not in sections]
    if missing:
        raise ParseError(f"missing required sections: {missing}")

    topics = [
        BULLET_RE.match(line.strip()).group(1).strip()
        for line in sections["Topics"].splitlines()
        if BULLET_RE.match(line.strip())
    ]
    if len(topics) < 5:
        raise ParseError(f"need >=5 topics, found {len(topics)}")

    return {
        "role": sections["Role"],
        "tagline": sections["Tagline"],
        "free_skills": sections["Free skills"],
        "paid_skills": sections["Paid skills"],
        "contact": sections["Contact"],
        "tone": sections["Tone"],
        "topics": topics,
    }
