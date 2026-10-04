---
description: Stop an active background Muse Code run in this repository
argument-hint: '[run-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/muse-bridge.mjs" stop "$ARGUMENTS"`

Present the command output to the user and stop there. The user cancelled the run, so:
- Do not start, restart, or resume a Muse run.
- Do not continue or finish the cancelled task yourself.
- Do not edit or revert files. If the report's `Mode:` line says the run was write-capable, pass on where it may have left partial edits (the working tree, or its own worktree) and let the user decide what to keep.
