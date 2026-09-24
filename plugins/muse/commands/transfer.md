---
description: Transfer the current Claude Code session into a resumable Muse Code session
argument-hint: "[--source <claude-jsonl>] [--condensed] [--model <model|spark|contributor>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/muse-bridge.mjs" transfer "$ARGUMENTS"`

Present the command output to the user exactly as returned. Preserve the Muse session ID and the `muse resume <session-id>` command. The bridge asks Muse to import the transcript with its bundled `resume-claude` skill and falls back to a condensed transcript if that does not complete; `--condensed` forces the fallback. `--model` (a catalog id or the aliases `spark`, `contributor`, `spark-1.2`) and `--effort` apply to both the native import and the fallback.
