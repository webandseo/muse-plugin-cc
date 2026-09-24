---
description: Check whether Muse Code is reachable and authenticated for the Claude Code bridge, and optionally toggle the stop-time review gate
argument-hint: '[--probe] [--model <model|spark|contributor>] [--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/muse-bridge.mjs" check --json $ARGUMENTS
```

If the result says Muse is unavailable:
- Do not invent an install path. Muse Code installs with `curl https://dev.meta.ai/install.sh | bash` on macOS and Linux and `irm https://dev.meta.ai/install.ps1 | iex` in PowerShell on Windows (https://developer.meta.com/ai/products/muse-code/).
- Tell the user to install Muse Code and make sure `muse` is on PATH, or to set `MUSE_BINARY`.
- Then rerun `/muse:check` after they install it.

If Muse is installed but not authenticated:
- Preserve the guidance to authenticate with `muse login` (or `muse auth set --api-key-stdin`).
- Mention that `/muse:check --probe` confirms authentication with a one-step model call.

If Muse is already installed and authenticated:
- Do not ask about installation.

Native Windows sandbox:
- On a native Windows Muse install the output includes a `windows sandbox` line. If it is not `ready`, tell the user that reviews still work but delegate runs cannot run shell commands until they run `muse sandbox windows setup` in an elevated PowerShell, and that `MUSE_CC_DISABLE_SANDBOX=1` is the explicit opt-out.

Review gate:
- `--enable-review-gate` turns on a `Stop` hook that runs a Muse review of the previous Claude turn and blocks the stop if it finds issues. Warn that this can create a long Claude/Muse loop and should only be enabled when the user will actively monitor the session.
- `--disable-review-gate` turns it off.

Output rules:
- Present the final check output to the user, including the models (`models.detail`: what Muse's catalog offers and Muse's own default) and the model the plugin will actually pass (`models.selected.detail`: the id and whether it came from `--model`, `MUSE_CC_MODEL`, or the plugin default `spark`).
- If the selected model carries a note (for example the `contributor` model's statement that content may be used for product improvement), repeat that note verbatim and mention that `spark` (`muse-spark-1.3`, the plugin default) does not carry it.
- `--model` shows what a given model or alias resolves to, and `--probe` then checks it with that model.
- If the user passed a review-gate flag, confirm the new state.
