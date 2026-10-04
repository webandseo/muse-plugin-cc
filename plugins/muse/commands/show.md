---
description: Show the stored final output for a finished Muse Code run in this repository
argument-hint: '[run-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/muse-bridge.mjs" show --args-stdin <<'MUSE_CC_ARGS'
$ARGUMENTS
MUSE_CC_ARGS
`

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- Run ID and status
- The complete result payload, including verdict, summary, findings, details, artifacts, and next steps
- File paths and line numbers exactly as reported
- Any error messages or parse errors
- The Muse session ID and `muse resume <session-id>` command when present
- Follow-up commands such as `/muse:runs <id>` and `/muse:review`
