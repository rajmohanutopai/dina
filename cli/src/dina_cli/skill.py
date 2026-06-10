"""dina skill — render + install the Dina skill into agent platforms.

One canonical skill document, many agent platforms. Every modern agent
(Claude Code, Codex, Gemini CLI, OpenClaw, …) can run shell commands and
reads its operating instructions from a markdown file in a well-known
location — so "integrating Dina" with an agent is teaching it when to
call the `dina` CLI, and THAT is a docs-rendering problem, not an
SDK-per-platform problem.

Canonical sources (shipped inside this package so the text can never
drift from the installed CLI's actual commands):

  skill_assets/SKILL_BODY.md  — full command reference (skill-directory
                                platforms that load content on demand)
  skill_assets/SKILL_THIN.md  — trigger rules + progressive disclosure
                                (always-in-context instruction files
                                where token budget matters)

Targets:

  claude-code → ~/.claude/skills/dina/SKILL.md   (full, + frontmatter)
  openclaw    → ~/.openclaw/skills/dina/SKILL.md (full, + frontmatter)
  codex       → ~/.codex/AGENTS.md               (thin, managed block)
  gemini      → ~/.gemini/GEMINI.md              (thin, managed block)

Managed-block targets are idempotent: re-install replaces the block
between the BEGIN/END markers and never touches anything outside them.

Trust posture: this command edits the user's agent configuration — the
exact class of action Dina exists to gate. So the installer is loudly
transparent: it prints every path before writing, supports --dry-run,
and never writes a platform the user didn't confirm.
"""

from __future__ import annotations

from dataclasses import dataclass
from importlib import resources
from pathlib import Path

BEGIN_MARKER = "<!-- BEGIN DINA SKILL (managed by `dina skill install` — edits inside this block will be overwritten) -->"
END_MARKER = "<!-- END DINA SKILL -->"

_DESCRIPTION = (
    "Sovereign personal AI — encrypted vault, persona access control, "
    "PII scrubbing, session-scoped grants, action gating."
)


def _asset(name: str) -> str:
    return (resources.files("dina_cli") / "skill_assets" / name).read_text(encoding="utf-8")


def skill_body_full() -> str:
    return _asset("SKILL_BODY.md")


def skill_body_thin() -> str:
    return _asset("SKILL_THIN.md")


def render_claude_code() -> str:
    """Claude Code skill file: name/description frontmatter + full body.

    Claude Code loads skill bodies on demand (the frontmatter description
    is what occupies the always-on context), so the full reference is the
    right variant here.
    """
    frontmatter = (
        "---\n"
        "name: dina\n"
        f"description: {_DESCRIPTION} Use when the user references their personal data, reminders, or asks you to act on their behalf (email, purchases, sharing).\n"
        "---\n\n"
    )
    return frontmatter + skill_body_full()


def render_openclaw() -> str:
    """OpenClaw skill file: openclaw-metadata frontmatter + full body."""
    frontmatter = (
        "---\n"
        "name: dina\n"
        f"description: {_DESCRIPTION}\n"
        "metadata:\n"
        "  openclaw:\n"
        '    emoji: "🛡️"\n'
        "    homepage: https://github.com/rajmohanutopai/dina\n"
        "    requires:\n"
        "      bins:\n"
        "        - dina\n"
        "    install:\n"
        "      - id: pip\n"
        "        kind: pip\n"
        "        package: dina-agent\n"
        "        bins: [dina]\n"
        '        label: "Install Dina CLI (pip install dina-agent)"\n'
        "---\n\n"
    )
    return frontmatter + skill_body_full()


def render_managed_block() -> str:
    """Thin variant wrapped in idempotency markers, for AGENTS.md-style
    files that sit in the agent's context every turn."""
    return f"{BEGIN_MARKER}\n\n{skill_body_thin().strip()}\n\n{END_MARKER}\n"


def upsert_managed_block(existing: str, block: str) -> str:
    """Insert or replace the managed block in an instructions file.

    Everything outside the markers is preserved byte-for-byte. A file
    without markers gets the block appended (with a separating blank
    line). Returns the new content.
    """
    begin = existing.find(BEGIN_MARKER)
    end = existing.find(END_MARKER)
    if begin != -1 and end != -1 and end > begin:
        after = end + len(END_MARKER)
        # Swallow exactly one trailing newline of the old block so
        # repeated installs don't accumulate blank lines.
        if after < len(existing) and existing[after] == "\n":
            after += 1
        return existing[:begin] + block + existing[after:]
    if existing.strip() == "":
        return block
    return existing.rstrip("\n") + "\n\n" + block


@dataclass(frozen=True)
class SkillTarget:
    key: str
    label: str
    # Directory whose existence means "this platform is installed here".
    detect_dir: str
    # Path to write, relative to home.
    rel_path: str
    # 'file' = overwrite whole file; 'block' = managed block upsert.
    mode: str

    def detected(self, home: Path) -> bool:
        return (home / self.detect_dir).is_dir()

    def path(self, home: Path) -> Path:
        return home / self.rel_path

    def render(self) -> str:
        if self.key == "claude-code":
            return render_claude_code()
        if self.key == "openclaw":
            return render_openclaw()
        return render_managed_block()


TARGETS: tuple[SkillTarget, ...] = (
    SkillTarget(
        key="claude-code",
        label="Claude Code",
        detect_dir=".claude",
        rel_path=".claude/skills/dina/SKILL.md",
        mode="file",
    ),
    SkillTarget(
        key="openclaw",
        label="OpenClaw",
        detect_dir=".openclaw",
        rel_path=".openclaw/skills/dina/SKILL.md",
        mode="file",
    ),
    SkillTarget(
        key="codex",
        label="Codex CLI",
        detect_dir=".codex",
        rel_path=".codex/AGENTS.md",
        mode="block",
    ),
    SkillTarget(
        key="gemini",
        label="Gemini CLI",
        detect_dir=".gemini",
        rel_path=".gemini/GEMINI.md",
        mode="block",
    ),
)


@dataclass(frozen=True)
class InstallResult:
    target: SkillTarget
    path: Path
    # 'created' | 'updated' | 'unchanged' | 'dry-run'
    action: str


def install_target(target: SkillTarget, home: Path, dry_run: bool = False) -> InstallResult:
    """Write (or preview) one target. Never touches anything outside the
    target path; managed-block mode preserves all non-block content."""
    path = target.path(home)
    if target.mode == "file":
        new_content = target.render()
        old_content = path.read_text(encoding="utf-8") if path.is_file() else None
    else:
        existing = path.read_text(encoding="utf-8") if path.is_file() else ""
        new_content = upsert_managed_block(existing, render_managed_block())
        old_content = existing if path.is_file() else None

    if old_content == new_content:
        return InstallResult(target=target, path=path, action="unchanged")
    if dry_run:
        return InstallResult(target=target, path=path, action="dry-run")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(new_content, encoding="utf-8")
    return InstallResult(
        target=target, path=path, action="updated" if old_content is not None else "created"
    )


def detect_targets(home: Path) -> list[SkillTarget]:
    return [t for t in TARGETS if t.detected(home)]


def target_by_key(key: str) -> SkillTarget | None:
    for t in TARGETS:
        if t.key == key:
            return t
    return None
