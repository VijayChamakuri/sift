"""Refuse to touch a test split until the pre-registration is committed and the split is unlocked.

Test A needs PREREGISTRATION.md committed in an ancestor of HEAD. Test B additionally needs
the Q3 freeze tag. A run that fails these checks stops before reading any case.
"""

from __future__ import annotations

import subprocess

from .data import ROOT

FREEZE_TAGS = {"test_a": None, "test_b": "q3-frozen"}


class LockedSplit(RuntimeError):
    pass


def _git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=ROOT, capture_output=True, text=True, check=False
    ).stdout.strip()


def require_preregistered(split: str) -> None:
    commit = _git("log", "-1", "--format=%H", "--", "PREREGISTRATION.md")
    if not commit:
        raise LockedSplit(
            f"SIFT-E301 {split} is locked: PREREGISTRATION.md has never been committed.\n"
            "fix: commit PREREGISTRATION.md, then rerun"
        )
    if _git("status", "--porcelain", "--", "PREREGISTRATION.md"):
        raise LockedSplit(
            f"SIFT-E302 {split} is locked: PREREGISTRATION.md has uncommitted changes.\n"
            "fix: commit or revert PREREGISTRATION.md, then rerun"
        )
    tag = FREEZE_TAGS[split]
    if tag and not _git("tag", "--list", tag):
        raise LockedSplit(
            f"SIFT-E303 {split} is locked until the Q3 configuration is frozen (tag {tag!r} missing).\n"
            f"fix: freeze Q3 on Dev, then run: git tag {tag}"
        )
