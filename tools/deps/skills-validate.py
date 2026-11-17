"""`python -I tools/deps/skills-validate.py <skill dir>...`: check each skill with the Agent Skills standard's reference
validator (skills-ref, its own parser and rules), where a skill may also carry the frontmatter fields a harness reads
beyond the standard's (HARNESS_FIELDS), each only with the value Factory writes. The standard's validator refuses every
field it does not define, and Claude Code hides a skill from its `/` menu only by such a field. Exits 1 when any skill
fails, naming each failure.
"""

import sys
from pathlib import Path

from skills_ref.errors import ParseError
from skills_ref.parser import find_skill_md, parse_frontmatter
from skills_ref.validator import validate_metadata

# Claude Code's `user-invocable: false`: out of the `/` menu, still loaded by the model when a task card names the skill.
HARNESS_FIELDS = {"user-invocable": "false"}


def check(skill_dir: Path) -> list[str]:
    skill_md = find_skill_md(skill_dir)
    if skill_md is None:
        return ["Missing required file: SKILL.md"]
    try:
        metadata, _ = parse_frontmatter(skill_md.read_text(encoding="utf-8"))
    except ParseError as e:
        return [str(e)]
    errors = [f"Field '{k}' must be {v}" for k, v in HARNESS_FIELDS.items() if k in metadata and metadata[k] != v]
    return errors + validate_metadata({k: v for k, v in metadata.items() if k not in HARNESS_FIELDS}, skill_dir)


failed = False
for arg in sys.argv[1:]:
    skill_dir = Path(arg)
    errors = check(skill_dir)
    if errors:
        failed = True
        print(f"Validation failed for {skill_dir}:\n" + "\n".join(f"  - {e}" for e in errors))
    else:
        print(f"Valid skill: {skill_dir}")
sys.exit(1 if failed or len(sys.argv) < 2 else 0)
