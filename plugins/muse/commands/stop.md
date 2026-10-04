---
description: Stop an active background Muse Code run in this repository
argument-hint: '[run-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/muse-bridge.mjs" stop --args-stdin <<'MUSE_CC_ARGS'
$ARGUMENTS
MUSE_CC_ARGS
`
