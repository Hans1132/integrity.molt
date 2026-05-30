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


def to_env(parsed: dict, commit_sha: str, timestamp_iso: str) -> str:
    """Serialize parsed identity to a bash/dotenv-source-able env file.

    Strings are single-quoted with ANSI-C escape for embedded apostrophes
    (the canonical bash-safe escape: ' -> '\\''). bash and python-dotenv
    both parse this format identically.
    """
    def q(s: str) -> str:
        # Replace ' with '\'' (close quote, escaped quote, open quote)
        return "'" + s.replace("'", "'\\''") + "'"

    lines = [
        f"# Auto-generated from docs/IDENTITY.md at {timestamp_iso}. DO NOT EDIT.",
        f"MOLTBOT_ROLE={q(parsed['role'])}",
        f"MOLTBOT_TAGLINE={q(parsed['tagline'])}",
        f"MOLTBOT_FREE_SKILLS={q(parsed['free_skills'])}",
        f"MOLTBOT_PAID_SKILLS={q(parsed['paid_skills'])}",
        f"MOLTBOT_CONTACT={q(parsed['contact'])}",
        f"MOLTBOT_TONE={q(parsed['tone'])}",
        f"MOLTBOT_TOPICS_COUNT={len(parsed['topics'])}",
    ]
    for i, t in enumerate(parsed["topics"]):
        lines.append(f"MOLTBOT_TOPIC_{i}={q(t)}")
    lines.append(f"MOLTBOT_IDENTITY_UPDATED_AT={q(timestamp_iso)}")
    lines.append(f"MOLTBOT_IDENTITY_COMMIT={q(commit_sha)}")
    return "\n".join(lines) + "\n"
