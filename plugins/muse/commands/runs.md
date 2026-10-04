---
description: Show active and recent Muse Code runs for this repository, including review-gate status
argument-hint: '[run-id] [--wait] [--timeout-ms <ms>] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/muse-bridge.mjs" runs --args-stdin <<'MUSE_CC_ARGS'
$ARGUMENTS
MUSE_CC_ARGS
`

If the user did not pass a run ID:
- Render the command output as a single Markdown table for the current and past runs in this session.
- Keep it compact. Do not include progress blocks or extra prose outside the table.
- Preserve the actionable fields from the command output, including run ID, kind, status, phase, elapsed or duration, summary, and follow-up commands.

If the user did pass a run ID:
- Present the full command output to the user.
- Do not summarize or condense it.
