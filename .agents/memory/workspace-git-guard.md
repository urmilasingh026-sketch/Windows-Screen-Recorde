---
name: Workspace Git guard
description: Replit workspace protection for commands that modify Git metadata or history.
---

Git operations that modify repository metadata or history can be blocked unless the command is prefixed with `DANGEROUSLY_ALLOW_GIT=1`.

**Why:** Replit protects its managed Git setup from accidental changes.

**How to apply:** Inspect the current branch and working tree first. Use the prefix only for Git writes required by the user's explicit request; avoid unnecessary history or cleanup operations.
