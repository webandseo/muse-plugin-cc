# Changelog

## Unreleased

- The one-write-run-per-repository guard is now atomic. The check and the new run's record happen under one state lock, so `run --write` calls started at the same moment can no longer all pass the check before any of them is recorded.
- Backslashes survive slash-command arguments. A `\` escapes only a quote or whitespace, so Windows paths (`/muse:transfer --source C:\Users\...`, `/muse:delegate --image C:\...`, `\\server\share`) and prompt text such as `\d+` reach the bridge intact. They used to lose every backslash.
- `/muse:stop` tells Claude to report the cancellation and do nothing else: no new or resumed run, no finishing the task itself, no file edits.

## 0.2.0

This release is from the webandseo fork ([webandseo/muse-plugin-cc](https://github.com/webandseo/muse-plugin-cc)) of [rtravellin/muse-code-plugin-cc](https://github.com/rtravellin/muse-code-plugin-cc). The marketplace is now `webandseo-muse` (`/plugin install muse@webandseo-muse`); the plugin is still `muse`.

- No more concurrent duplicate write runs. `run --write` refuses to start while another write-capable delegate run in the same repository is still alive, and names the run to follow (`/muse:runs <id> --wait`) or stop (`/muse:stop <id>`). Records whose processes have died are marked failed instead of blocking; `--allow-concurrent` overrides. The `muse:muse-delegate` subagent now sets the Bash tool timeout to 600000 ms, never calls `run` again when its call is backgrounded or times out, and never forwards `--wait` to the bridge. Foreground runs print their run id. The process liveness check no longer shells out to `ps` on Windows, where it made every live process look dead.
- `/muse:transfer` accepts `--model` (with the `spark`, `contributor`, `spark-1.2` aliases) and `--effort`, and passes them to both the native `resume-claude` import and the condensed fallback. It used to warn "ignoring unknown option --model" and run on Muse's default.
- Every `muse exec` the plugin launches (review, critique, delegate, transfer, stop-time gate, `check --probe`) passes `--no-foreign-personal-context`, so Muse no longer loads your `~/.claude` skills and personal rules into runs made for Claude Code. `MUSE_CC_FOREIGN_CONTEXT=1` restores the old behaviour.
- Privacy-first default model. Without `--model`, runs use `MUSE_CC_MODEL` (alias or full id) or else `spark` (`muse-spark-1.3`), never Muse's own default, `muse-spark-1.3-contributor`, whose content may be used for product improvement. `--model contributor` still selects it explicitly. `/muse:check` shows the model that will be used and where it came from (`--model`, `MUSE_CC_MODEL`, or the plugin default), and accepts `--model`.

## 0.1.0

- Initial release.
- `/muse:check`, `/muse:review`, `/muse:critique`, `/muse:delegate`, `/muse:transfer`, `/muse:sync-skills`, `/muse:runs`, `/muse:show`, `/muse:stop`.
- `muse:muse-delegate` subagent with `--resume` support (continues the same `muse exec --session-id`).
- `/muse:delegate --worktree` (the bridge creates a git worktree on `muse/session-<id>` and hands it to Muse) and `--image`; model aliases `spark`, `contributor`, `spark-1.2`.
- `/muse:transfer` imports natively through Muse's bundled `resume-claude` skill, with a condensed-transcript fallback.
- Optional stop-time review gate (`/muse:check --enable-review-gate`).
- Windows: runs the `muse-bin-<version>.exe` beside Meta's shim directly; `/muse:check` reports the Windows sandbox state; `MUSE_CC_DISABLE_SANDBOX=1` is an opt-in.
- README demo (`docs/demo.svg`), rendered from one recorded session by `npm run build-demo-script` and `npm run render-demo`.
