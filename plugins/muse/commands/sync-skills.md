---
description: Import your Claude Code skills into Muse Code with Muse's own importer
argument-hint: '[--dry-run] [--force]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/muse-bridge.mjs" sync-skills --args-stdin <<'MUSE_CC_ARGS'
$ARGUMENTS
MUSE_CC_ARGS
`

Present the command output to the user as returned. It wraps `muse skills import --from claude`, which reads `~/.claude/skills` and installs them as Muse user skills. `--dry-run` lists what would be imported; `--force` overwrites skills that already exist in Muse.
