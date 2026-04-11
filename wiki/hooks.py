"""MkDocs build hooks for the PushFlip wiki.

Injects build-time metadata (short git hash + ISO build date) into
``config.extra`` so the Material theme footer can render
"built <hash> on <date>" via the ``copyright:`` template in mkdocs.yml.

The hook fails open: if git is unavailable (e.g. in a Docker build that
doesn't pass the .git directory through), the values fall back to "dev"
and "unknown" rather than crashing the build.
"""

from __future__ import annotations

import datetime
import subprocess


def on_config(config, **kwargs):
    """Populate config.extra.git_hash and config.extra.build_date."""
    git_hash = "dev"
    try:
        git_hash = subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"],
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip() or "dev"
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass

    config.extra["git_hash"] = git_hash
    config.extra["build_date"] = datetime.date.today().isoformat()
    return config
